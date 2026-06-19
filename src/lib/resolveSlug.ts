/**
 * Shared slug resolution logic.
 *
 * Strategy:
 *  1. Detect multi-part series using pre-fetched relations data (no extra API call)
 *  2. Build expanded search term list from english/romaji/native + part-aware variants
 *  3. Parallel search all terms → deduplicate candidates
 *  4. MAL ID exact match on detail pages (top 12, scored-first)
 *  5. Score heuristic fallback
 */

import { scrapeSearch } from './scrapers/search.scraper';
import { scrapeAnimeDetail } from './scrapers/anime.scraper';

interface CandidateWithMeta {
  slug: string;
  title: string;
  titleJp?: string;
  type?: string;
  year?: string;
  date?: string;
  totalEpisodes?: number;
}

interface KnownMeta {
  english?: string;
  romaji?: string;
  native?: string;
  type?: string;
  year?: number;
  episodes?: number;
}

export interface AniListRelationEdge {
  relationType: string;
  node: { id: number; title: { romaji?: string; english?: string } };
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Determine part number using already-fetched relations data — no extra API call.
 *
 * - If own title has "Part N" → return N directly
 * - If a SEQUEL's title shares the base name and has "Part N" → this entry is Part 1
 */
function detectPartNumber(
  titles: { english?: string; romaji?: string; native?: string },
  relations: AniListRelationEdge[]
): number | null {
  const titleStr = titles.english || titles.romaji || '';

  // Own title already has "Part N"
  const selfPartMatch = titleStr.match(/\bpart\s*(\d+)\b/i);
  if (selfPartMatch) return parseInt(selfPartMatch[1], 10);

  // Check SEQUEL relations for "Part N" to identify this as Part 1
  const baseTitle = titleStr.toLowerCase();
  for (const edge of relations) {
    if (edge.relationType !== 'SEQUEL') continue;
    const relTitle = (edge.node.title.english || edge.node.title.romaji || '').toLowerCase();
    const partMatch = relTitle.match(/\bpart\s*(\d+)\b/i);
    if (!partMatch) continue;
    // Verify shared base (compare first 10 chars of base stripped title)
    const relBase = relTitle.replace(/\bpart\s*\d+\b/i, '').replace(/\s+/g, ' ').trim();
    if (
      baseTitle.includes(relBase.substring(0, 10)) ||
      relBase.includes(baseTitle.substring(0, 10))
    ) {
      console.info(`[detectPartNumber] Part 1 detected via sequel "${edge.node.title.english}"`);
      return 1;
    }
  }

  return null;
}

/**
 * Expand search terms, injecting "Part N" variants when partNumber is known
 * and the title doesn't already contain it.
 */
function expandSearchTerms(
  titles: { english?: string; romaji?: string; native?: string },
  partNumber: number | null
): string[] {
  const raw = [titles.english, titles.romaji, titles.native].filter(Boolean) as string[];
  const expanded = new Set<string>(raw);

  for (const t of raw) {
    const noColon = t.replace(/:\s*the\s+/i, ' ').replace(/:\s*/i, ' ').trim();
    if (noColon !== t) expanded.add(noColon);

    const base = t
      .replace(/:\s*(the\s+)?final\s+season.*/i, '')
      .replace(/:\s*season\s+\d+.*/i, '')
      .replace(/\s+(season|part|cour|arc)\s+\d+.*/i, '')
      .replace(/\s+s\d+$/i, '')
      .trim();
    if (base && base !== t) expanded.add(base);

    const beforeColon = t.split(':')[0].trim();
    if (beforeColon && beforeColon !== t) expanded.add(beforeColon);

    // Inject "Part N" variant for titles that don't already have it
    if (partNumber !== null && !/\bpart\s*\d+\b/i.test(t)) {
      expanded.add(`${t} Part ${partNumber}`);
      if (noColon !== t) expanded.add(`${noColon} Part ${partNumber}`);
    }
  }

  return [...expanded];
}

/** Score how well a candidate matches the known AniList media. */
function scoreCandidate(candidate: CandidateWithMeta, known: KnownMeta): number {
  let score = 0;

  const normEn  = normalizeTitle(known.english ?? '');
  const normRom = normalizeTitle(known.romaji  ?? '');
  const normNat = normalizeTitle(known.native  ?? '');
  const cEn     = normalizeTitle(candidate.title   ?? '');
  const cJp     = normalizeTitle(candidate.titleJp ?? '');

  if      (normEn  && cEn === normEn)           score += 50;
  else if (normRom && cEn === normRom)           score += 45;
  else if (normNat && cEn === normNat)           score += 40;
  else if (normEn  && cEn.startsWith(normEn))   score += 20;
  else if (normRom && cEn.startsWith(normRom))  score += 18;
  else if (normEn  && normEn.startsWith(cEn) && cEn.length > 6)  score += 10;
  else if (normRom && normRom.startsWith(cEn) && cEn.length > 6) score += 8;

  if      (normNat && cJp === normNat)   score += 40;
  else if (normRom && cJp === normRom)   score += 35;
  else if (normEn  && cJp === normEn)    score += 30;

  const slugNorm = normalizeTitle(candidate.slug);
  if      (normEn  && slugNorm.startsWith(normEn))   score += 15;
  else if (normRom && slugNorm.startsWith(normRom))  score += 12;
  const slugStripped = normalizeTitle(candidate.slug.replace(/-[a-z0-9]{4,8}$/, ''));
  if      (normEn  && slugStripped === normEn)   score += 30;
  else if (normRom && slugStripped === normRom)  score += 25;

  if (candidate.type && known.type) {
    const typeMap: Record<string, string> = {
      movie: 'movie', tv: 'tv', ova: 'ova',
      ona: 'ona', special: 'special', music: 'music', 'tv short': 'tv',
    };
    const cT = typeMap[candidate.type.toLowerCase()] ?? candidate.type.toLowerCase();
    const kT = typeMap[known.type.toLowerCase()]     ?? known.type.toLowerCase();
    if (cT === kT) score += 20; else score -= 30;
  }

  const cy = candidate.year
    ? parseInt(candidate.year)
    : candidate.date
      ? parseInt((candidate.date.match(/\d{4}/) ?? [])[0] ?? '0')
      : 0;
  if (cy && known.year) {
    if (cy === known.year)                    score += 20;
    else if (Math.abs(cy - known.year) === 1) score += 5;
    else                                      score -= 15;
  }

  if (candidate.totalEpisodes && known.episodes) {
    if (candidate.totalEpisodes === known.episodes)                   score += 25;
    else if (Math.abs(candidate.totalEpisodes - known.episodes) <= 2) score += 10;
    else                                                              score -= 10;
  }

  return score;
}

/**
 * Resolve an anikoto slug from AniList media info.
 *
 * @param titles    - { english, romaji, native } from AniList
 * @param malId     - MAL ID for exact page-level matching
 * @param meta      - { type, year, episodes } for scoring
 * @param relations - Pre-fetched AniList relation edges (avoids extra API call)
 */
export async function resolveSlug(
  titles: { english?: string; romaji?: string; native?: string },
  malId: number | null | undefined,
  meta: { type?: string; year?: number; episodes?: number } = {},
  relations: AniListRelationEdge[] = []
): Promise<string | null> {

  const partNumber = detectPartNumber(titles, relations);
  if (partNumber !== null) {
    console.info(`[resolveSlug] Part ${partNumber} for "${titles.english || titles.romaji}"`);
  }

  const searchTerms = expandSearchTerms(titles, partNumber);
  if (!searchTerms.length) return null;

  const searchResults = await Promise.all(
    searchTerms.map((kw) =>
      scrapeSearch(kw).then((r) => r.results).catch(() => [] as CandidateWithMeta[])
    )
  );

  const seen = new Set<string>();
  const allCandidates: CandidateWithMeta[] = searchResults.flat().filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });

  if (!allCandidates.length) return null;

  // Augment scoring titles with "Part N" if detected
  const scoringTitles = { ...titles };
  if (partNumber !== null) {
    const hasPart = /\bpart\s*\d+\b/i;
    if (scoringTitles.english && !hasPart.test(scoringTitles.english)) {
      scoringTitles.english = `${scoringTitles.english} Part ${partNumber}`;
    }
    if (scoringTitles.romaji && !hasPart.test(scoringTitles.romaji)) {
      scoringTitles.romaji = `${scoringTitles.romaji} Part ${partNumber}`;
    }
  }

  const known: KnownMeta = { ...scoringTitles, ...meta };
  const scored = allCandidates
    .map((c) => ({ ...c, score: scoreCandidate(c, known) }))
    .sort((a, b) => b.score - a.score);

  // MAL ID exact match — top 12
  if (malId) {
    const top = scored.slice(0, 12);
    const results = await Promise.allSettled(
      top.map(async (c) => {
        const detail = await scrapeAnimeDetail(c.slug);
        return { slug: c.slug, malId: detail.malId };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.malId === malId) {
        console.info(`[resolveSlug] MAL ${malId} matched → ${r.value.slug}`);
        return r.value.slug;
      }
    }
    console.warn(`[resolveSlug] MAL ${malId} not in top 12, using score fallback`);
  }

  console.info(
    `[resolveSlug] score fallback for "${titles.english || titles.romaji}":`,
    scored.slice(0, 3).map((s) => `${s.slug} (${s.score})`)
  );

  return scored[0]?.score >= 25 ? scored[0].slug : null;
}
