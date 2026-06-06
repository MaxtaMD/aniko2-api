import { NextResponse } from 'next/server';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { scrapeSearch } from '@/lib/scrapers/search.scraper';
import { scrapeWatch } from '@/lib/scrapers/watch.scraper';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/anilist/[id]/[ep]
 *
 * Examples:
 *   /api/watch/anilist/21/1163
 *   /api/watch/anilist/16498/1
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; ep: string }> }
) {
  try {
    const { id, ep } = await params;
    const anilistId = parseInt(id, 10);

    if (isNaN(anilistId) || anilistId <= 0) {
      return NextResponse.json({ ok: false, message: 'Invalid AniList ID' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const refresh = searchParams.get('refresh') === '1';
    const cacheKey = `watch:anilist:${anilistId}:${ep}`;

    const data = refresh
      ? await resolveAndWatch(anilistId, ep)
      : await getOrSet(cacheKey, () => resolveAndWatch(anilistId, ep), CACHE_TTL.EPISODE);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/watch/anilist/[id]/[ep]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

// ── Title normaliser ──────────────────────────────────────────────────────────
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Score a search candidate against known titles ─────────────────────────────
// Mirrors the scoring logic from Anivexa's anikoto provider
function scoreCandidate(
  candidate: { slug: string; title: string; titleJp?: string; type?: string; year?: string; date?: string },
  known: { english?: string; romaji?: string; native?: string; type?: string; year?: number; episodes?: number }
): number {
  let score = 0;

  const normEn  = normalizeTitle(known.english  ?? '');
  const normRom = normalizeTitle(known.romaji   ?? '');
  const normNat = normalizeTitle(known.native   ?? '');
  const cEn     = normalizeTitle(candidate.title   ?? '');
  const cJp     = normalizeTitle(candidate.titleJp ?? '');

  // English title match
  if (normEn  && cEn === normEn)  score += 50;
  else if (normRom && cEn === normRom) score += 45;
  else if (normEn  && cEn.startsWith(normEn)) score += 15;

  // Japanese/native title match
  if (normNat && cJp === normNat) score += 40;
  else if (normRom && cJp === normRom) score += 35;

  // Type match/mismatch — normalize both sides to lowercase
  // AniList returns "TV", "MOVIE", "OVA" etc (uppercase)
  // Anikoto returns "TV", "Movie", "OVA" etc (mixed case)
  if (candidate.type && known.type) {
    const cType = candidate.type.toLowerCase().replace('_', ' ');
    const kType = known.type.toLowerCase().replace('_', ' ');
    // Map AniList format values to anikoto equivalents
    const typeMap: Record<string, string> = {
      'movie': 'movie',
      'tv': 'tv',
      'ova': 'ova',
      'ona': 'ona',
      'special': 'special',
      'music': 'music',
      'tv short': 'tv',
    };
    const normalizedC = typeMap[cType] ?? cType;
    const normalizedK = typeMap[kType] ?? kType;
    if (normalizedC === normalizedK) score += 20;
    else score -= 30;
  }

  // Year — extract from candidate.date string if candidate.year is absent
  const candidateYear = candidate.year
    ? parseInt(candidate.year)
    : candidate.date
      ? parseInt((candidate.date.match(/\d{4}/) ?? [])[0] ?? '0')
      : 0;

  if (candidateYear && known.year) {
    if (candidateYear === known.year) score += 20;
    else score -= 15;
  }

  // Episode count match — helps distinguish between seasons of same series
  const candidateEps = (candidate as { totalEpisodes?: number }).totalEpisodes ?? 0;
  if (candidateEps && known.episodes) {
    if (candidateEps === known.episodes) score += 25;
    else if (Math.abs(candidateEps - known.episodes) <= 2) score += 10;
    else score -= 10;
  }

  return score;
}

async function resolveAndWatch(anilistId: number, ep: string) {
  // ── 1. Fetch rich metadata from AniList ───────────────────────────────────
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        seasonYear
        format
        episodes
        title { romaji english native }
      }
    }
  `;

  const resp = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { id: anilistId } }),
  });

  if (!resp.ok) throw new Error(`AniList API error: ${resp.status}`);

  const json = (await resp.json()) as {
    data?: {
      Media?: {
        id: number;
        idMal?: number;
        seasonYear?: number;
        format?: string;
        episodes?: number;
        title: { romaji?: string; english?: string; native?: string };
      };
    };
  };

  const media = json?.data?.Media;
  if (!media) throw new Error(`AniList ID ${anilistId} not found`);

  // ── 2. Resolve slug with scoring ──────────────────────────────────────────
  const slug = await resolveSlug(media.title, {
    type: media.format,
    year: media.seasonYear,
    episodes: media.episodes,
  });

  if (!slug) {
    throw new Error(
      `Could not find "${media.title.english || media.title.romaji}" on anikototv.to`
    );
  }

  const watchData = await scrapeWatch(slug, ep);

  return { anilistId, malId: media.idMal ?? undefined, slug, ...watchData };
}

// ── Resolve slug using multi-keyword search + scoring ─────────────────────────
async function resolveSlug(
  title: { english?: string; romaji?: string; native?: string },
  meta: { type?: string; year?: number; episodes?: number }
): Promise<string | null> {
  // Collect unique non-empty search keywords
  const keywords = [...new Set(
    [title.english, title.romaji, title.native].filter(Boolean) as string[]
  )];

  // Run all searches in parallel
  const searchResults = await Promise.all(
    keywords.map((kw) =>
      scrapeSearch(kw)
        .then((r) => r.results)
        .catch(() => [] as { slug: string; title: string; titleJp?: string }[])
    )
  );

  // Deduplicate candidates by slug
  const seen = new Set<string>();
  const candidates = searchResults.flat().filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });

  if (!candidates.length) return null;

  // Score each candidate — pick highest score (min 0 to avoid garbage matches)
  const scored = candidates
    .map((c) => ({
      ...c,
      score: scoreCandidate(
        { ...c, type: (c as { type?: string }).type, year: (c as { year?: string }).year, date: (c as { date?: string }).date },
        { ...title, ...meta }
      ),
    }))
    .sort((a, b) => b.score - a.score);

  console.info(
    `[resolveSlug] top candidates for "${title.english || title.romaji}":`,
    scored.slice(0, 3).map((s) => `${s.slug} (score=${s.score})`)
  );

  return scored[0].score >= 0 ? scored[0].slug : null;
}
