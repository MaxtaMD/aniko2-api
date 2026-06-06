/**
 * Shared slug resolution logic.
 *
 * Strategy:
 *  1. Fetch AniList relations to detect multi-part series and derive part number
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

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Query AniList relations to determine which "part" this entry is in a multi-part series.
 *
 * For series like AoT Final Season:
 *   - Part 1 (no "Part N" in title) is the root — it has SEQUEL relations to Part 2, 3...
 *   - Part 2+ have PREQUEL relations back to Part 1
 *
 * Returns the part number (1-based) if this is a multi-part series, or null if standalone.
 *
 * We detect multi-part by checking if ANY related entry (PREQUEL or SEQUEL) shares
 * the same base title and has "Part N" in its title — which means THIS entry is Part 1.
 * Or if THIS entry has "Part N" in its own title.
 */
async function detectPartNumber(
  anilistId: number,
  titles: { english?: string; romaji?: string; native?: string }
): Promise<number | null> {
  // First check if the title itself has "Part N"
  const titleStr = titles.english || titles.romaji || '';
  const selfPartMatch = titleStr.match(/\bpart\s*(\d+)\b/i);
  if (selfPartMatch) {
    return parseInt(selfPartMatch[1], 10);
  }

  // No "Part N" in own title — could still be Part 1 if sequels have "Part N"
  // Query AniList for SEQUEL relations
  try {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          relations {
            edges {
              relationType
              node {
                id
                title { romaji english }
              }
            }
          }
        }
      }
    `;

    const resp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { id: anilistId } }),
    });

    if (!resp.ok) return null;

    const json = (await resp.json()) as {
      data?: {
        Media?: {
          relations?: {
            edges: Array<{
              relationType: string;
              node: { id: number; title: { romaji?: string; english?: string } };
            }>;
          };
        };
      };
    };

    const edges = json?.data?.Media?.relations?.edges ?? [];
    const baseTitle = (titles.english || titles.romaji || '').toLowerCase();

    // Check if any SEQUEL shares the same base name and has "Part N"
    for (const edge of edges) {
      if (edge.relationType !== 'SEQUEL') continue;
      const relTitle = (edge.node.title.english || edge.node.title.romaji || '').toLowerCase();
      const partMatch = relTitle.match(/\bpart\s*(\d+)\b/i);
      if (partMatch) {
        // Verify it shares the same base name (ignore "part N" suffix)
        const relBase = relTitle.replace(/\bpart\s*\d+\b/i, '').replace(/\s+/g, ' ').trim();
        const thisBase = baseTitle.replace(/\s+/g, ' ').trim();
        if (thisBase.includes(relBase.substring(0, 10)) || relBase.includes(thisBase.substring(0, 10))) {
          // This entry is Part 1 — the sequel is Part N (N >= 2)
          console.info(`[detectPartNumber] ID ${anilistId} is Part 1 (sequel "${edge.node.title.english}" is Part ${partMatch[1]})`);
          return 1;
        }
      }
    }
  } catch (e) {
    console.warn('[detectPartNumber] relations query failed:', e);
  }

  return null;
}

/**
 * Strip common suffixes that anikoto doesn't include in search:
 *   "Attack on Titan: The Final Season Part 2"
 *   → also try "Attack on Titan Final Season Part 2"
 *   → also try "Attack on Titan"  (base series name)
 *
 * When partNumber is provided, also inject "Part N" variants for titles that
 * don't already contain it (i.e. Part 1 entries on AniList).
 */
function expandSearchTerms(
  titles: { english?: string; romaji?: string; native?: string },
  partNumber: number | null
): string[] {
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

    // If partNumber is given and the title doesn't already have "Part N",
    // inject a variant WITH "Part N" appended — this is the key fix for
    // AniList Part 1 entries whose title lacks "Part 1" but anikoto slug has it.
    if (partNumber !== null && !/\bpart\s*\d+\b/i.test(t)) {
      // e.g. "Shingeki no Kyojin: The Final Season" → "Shingeki no Kyojin: The Final Season Part 1"
      expanded.add(`${t} Part ${partNumber}`);

      // Also the colon-stripped variant + Part N
      if (noColon !== t) {
        expanded.add(`${noColon} Part ${partNumber}`);
      }
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
 * @param titles    - { english, romaji, native } from AniList
 * @param malId     - MAL ID for exact page-level matching (most reliable)
 * @param meta      - { type, year, episodes } for scoring
 * @param anilistId - AniList ID used for relations query (part detection)
 */
export async function resolveSlug(
  titles: { english?: string; romaji?: string; native?: string },
  malId: number | null | undefined,
  meta: { type?: string; year?: number; episodes?: number } = {},
  anilistId?: number | null
): Promise<string | null> {

  // Detect part number (handles "Part 1" entries whose AniList title lacks "Part 1")
  const partNumber = anilistId
    ? await detectPartNumber(anilistId, titles)
    : null;

  if (partNumber !== null) {
    console.info(`[resolveSlug] Detected part number ${partNumber} for "${titles.english || titles.romaji}"`);
  }

  const searchTerms = expandSearchTerms(titles, partNumber);
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

  // Build scoring titles — if this is a Part N entry, augment the english/romaji
  // titles with "Part N" so the scorer rewards "part-N" slugs correctly.
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
