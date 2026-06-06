/**
 * Shared slug resolution logic used across all anilist/mal watch routes.
 * Searches anikoto using all available titles (english, romaji, native),
 * deduplicates candidates, then picks the best match via:
 *   1. MAL ID exact match on detail page (most reliable)
 *   2. Score heuristic fallback
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

function scoreCandidate(candidate: CandidateWithMeta, known: KnownMeta): number {
  let score = 0;

  const normEn  = normalizeTitle(known.english  ?? '');
  const normRom = normalizeTitle(known.romaji   ?? '');
  const normNat = normalizeTitle(known.native   ?? '');
  const cEn     = normalizeTitle(candidate.title   ?? '');
  const cJp     = normalizeTitle(candidate.titleJp ?? '');

  // English title match
  if (normEn && cEn === normEn)        score += 50;
  else if (normRom && cEn === normRom) score += 45;
  else if (normNat && cEn === normNat) score += 40;
  else if (normEn  && cEn.startsWith(normEn))  score += 15;
  else if (normRom && cEn.startsWith(normRom)) score += 12;

  // JP/native title match
  if (normNat && cJp === normNat)       score += 40;
  else if (normRom && cJp === normRom)  score += 35;
  else if (normEn  && cJp === normEn)   score += 30;

  // Type match
  if (candidate.type && known.type) {
    const typeMap: Record<string, string> = {
      movie: 'movie', tv: 'tv', ova: 'ova',
      ona: 'ona', special: 'special', music: 'music', 'tv short': 'tv',
    };
    const cT = typeMap[candidate.type.toLowerCase()] ?? candidate.type.toLowerCase();
    const kT = typeMap[known.type.toLowerCase()]     ?? known.type.toLowerCase();
    if (cT === kT) score += 20; else score -= 30;
  }

  // Year match
  const cy = candidate.year
    ? parseInt(candidate.year)
    : candidate.date
      ? parseInt((candidate.date.match(/\d{4}/) ?? [])[0] ?? '0')
      : 0;
  if (cy && known.year) {
    if (cy === known.year)          score += 20;
    else if (Math.abs(cy - known.year) === 1) score += 5;
    else                            score -= 15;
  }

  // Episode count match
  if (candidate.totalEpisodes && known.episodes) {
    if (candidate.totalEpisodes === known.episodes)               score += 25;
    else if (Math.abs(candidate.totalEpisodes - known.episodes) <= 2) score += 10;
    else                                                          score -= 10;
  }

  return score;
}

/**
 * Resolve an anikoto slug from AniList media titles + optional MAL ID.
 *
 * @param titles  - { english, romaji, native } from AniList
 * @param malId   - MAL ID for exact matching on detail pages (optional)
 * @param meta    - { type, year, episodes } for scoring
 */
export async function resolveSlug(
  titles: { english?: string; romaji?: string; native?: string },
  malId: number | null | undefined,
  meta: { type?: string; year?: number; episodes?: number } = {}
): Promise<string | null> {

  // All unique non-empty search terms: english first, romaji, native last
  const searchTerms = [...new Set(
    [titles.english, titles.romaji, titles.native].filter(Boolean) as string[]
  )];

  if (!searchTerms.length) return null;

  // Parallel search across all three titles
  const searchResults = await Promise.all(
    searchTerms.map((kw) =>
      scrapeSearch(kw).then((r) => r.results).catch(() => [] as CandidateWithMeta[])
    )
  );

  // Deduplicate by slug
  const seen = new Set<string>();
  const candidates: CandidateWithMeta[] = searchResults.flat().filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });

  if (!candidates.length) return null;

  // 1. MAL ID exact match — check top 8 candidates in parallel
  if (malId) {
    const top = candidates.slice(0, 8);
    const results = await Promise.allSettled(
      top.map(async (c) => {
        const detail = await scrapeAnimeDetail(c.slug);
        return { slug: c.slug, malId: detail.malId };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.malId === malId) {
        console.info(`[resolveSlug] MAL ID ${malId} matched → ${r.value.slug}`);
        return r.value.slug;
      }
    }
    console.warn(`[resolveSlug] MAL ID ${malId} not matched in top candidates, falling back to score`);
  }

  // 2. Score heuristic fallback
  const known: KnownMeta = { ...titles, ...meta };
  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, known) }))
    .sort((a, b) => b.score - a.score);

  console.info(
    `[resolveSlug] score fallback for "${titles.english || titles.romaji}":`,
    scored.slice(0, 3).map((s) => `${s.slug} (${s.score})`)
  );

  return scored[0]?.score >= 30 ? scored[0].slug : null;
}
