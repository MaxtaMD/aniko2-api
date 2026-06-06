/**
 * Shared slug resolution logic.
 *
 * Strategy:
 *  1. Build expanded search term list from english/romaji/native + subtitle variants
 *  2. Parallel search all terms → deduplicate candidates
 *  3. MAL ID exact match on detail pages (top 12, scored-first)
 *  4. Score heuristic fallback
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

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Strip common suffixes that anikoto doesn't include in search:
 *   "Attack on Titan: The Final Season Part 2"
 *   → also try "Attack on Titan Final Season Part 2"
 *   → also try "Attack on Titan"  (base series name)
 */
function expandSearchTerms(titles: { english?: string; romaji?: string; native?: string }): string[] {
  const raw = [titles.english, titles.romaji, titles.native].filter(Boolean) as string[];
  const expanded = new Set<string>(raw);

  for (const t of raw) {
    // Strip leading "The " after colon  e.g. "X: The Final" → "X Final"
    const noColon = t.replace(/:\s*the\s+/i, ' ').replace(/:\s*/i, ' ').trim();
    if (noColon !== t) expanded.add(noColon);

    // Base series: strip everything from "Season", "Part", "Cour", "Arc", ordinal S2
    const base = t
      .replace(/:\s*(the\s+)?final\s+season.*/i, '')
      .replace(/:\s*season\s+\d+.*/i, '')
      .replace(/\s+(season|part|cour|arc)\s+\d+.*/i, '')
      .replace(/\s+s\d+$/i, '')
      .trim();
    if (base && base !== t) expanded.add(base);

    // Also try without subtitle after colon entirely
    const beforeColon = t.split(':')[0].trim();
    if (beforeColon && beforeColon !== t) expanded.add(beforeColon);
  }

  return [...expanded];
}

/** Score how well a candidate matches the known AniList media. */
function scoreCandidate(candidate: CandidateWithMeta, known: KnownMeta): number {
  let score = 0;

  const normEn  = normalizeTitle(known.english ?? '');
  const normRom = normalizeTitle(known.romaji  ?? '');
  const normNat = normalizeTitle(known.native  ?? '');
  const cEn     = normalizeTitle(candidate.title    ?? '');
  const cJp     = normalizeTitle(candidate.titleJp  ?? '');

  // ── Title match (candidate english title vs known titles) ──
  if      (normEn  && cEn === normEn)           score += 50;
  else if (normRom && cEn === normRom)           score += 45;
  else if (normNat && cEn === normNat)           score += 40;
  else if (normEn  && cEn.startsWith(normEn))   score += 20;
  else if (normRom && cEn.startsWith(normRom))  score += 18;
  // Partial containment (e.g. slug has base name inside)
  else if (normEn  && normEn.startsWith(cEn) && cEn.length > 6)  score += 10;
  else if (normRom && normRom.startsWith(cEn) && cEn.length > 6) score += 8;

  // ── JP/native title match ──
  if      (normNat && cJp === normNat)   score += 40;
  else if (normRom && cJp === normRom)   score += 35;
  else if (normEn  && cJp === normEn)    score += 30;

  // ── Slug-based matching (slug often mirrors en title faithfully) ──
  // e.g. slug "attack-on-titan-final-season-part-2-bures"
  const slugNorm = normalizeTitle(candidate.slug);
  if      (normEn  && slugNorm.startsWith(normEn))   score += 15;
  else if (normRom && slugNorm.startsWith(normRom))  score += 12;
  // Strip trailing uid suffix (e.g. "-bures", "-6d6cc") from slug for comparison
  const slugStripped = normalizeTitle(candidate.slug.replace(/-[a-z0-9]{4,8}$/, ''));
  if      (normEn  && slugStripped === normEn)   score += 30;
  else if (normRom && slugStripped === normRom)  score += 25;

  // ── Type match ──
  if (candidate.type && known.type) {
    const typeMap: Record<string, string> = {
      movie: 'movie', tv: 'tv', ova: 'ova',
      ona: 'ona', special: 'special', music: 'music', 'tv short': 'tv',
    };
    const cT = typeMap[candidate.type.toLowerCase()] ?? candidate.type.toLowerCase();
    const kT = typeMap[known.type.toLowerCase()]     ?? known.type.toLowerCase();
    if (cT === kT) score += 20; else score -= 30;
  }

  // ── Year match ──
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

  // ── Episode count match ──
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
 * @param titles - { english, romaji, native } from AniList
 * @param malId  - MAL ID for exact page-level matching (most reliable)
 * @param meta   - { type, year, episodes } for scoring
 */
export async function resolveSlug(
  titles: { english?: string; romaji?: string; native?: string },
  malId: number | null | undefined,
  meta: { type?: string; year?: number; episodes?: number } = {}
): Promise<string | null> {

  const searchTerms = expandSearchTerms(titles);
  if (!searchTerms.length) return null;

  // Parallel search across all terms
  const searchResults = await Promise.all(
    searchTerms.map((kw) =>
      scrapeSearch(kw).then((r) => r.results).catch(() => [] as CandidateWithMeta[])
    )
  );

  // Deduplicate by slug, preserving first-seen order
  const seen = new Set<string>();
  const allCandidates: CandidateWithMeta[] = searchResults.flat().filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });

  if (!allCandidates.length) return null;

  // Pre-score all candidates so MAL ID check prioritises closest matches
  const known: KnownMeta = { ...titles, ...meta };
  const scored = allCandidates
    .map((c) => ({ ...c, score: scoreCandidate(c, known) }))
    .sort((a, b) => b.score - a.score);

  // 1. MAL ID exact match — check top 12 by score in parallel
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

  // 2. Score fallback
  console.info(
    `[resolveSlug] score fallback for "${titles.english || titles.romaji}":`,
    scored.slice(0, 3).map((s) => `${s.slug} (${s.score})`)
  );

  return scored[0]?.score >= 25 ? scored[0].slug : null;
}
