import { NextResponse } from 'next/server';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

/**
 * GET /api/anime/by-mal/[id]
 *
 * Resolves a MyAnimeList (MAL) anime ID to an anikoto slug.
 * Uses AniList GraphQL to resolve the MAL ID to a title + AniList ID,
 * then searches anikoto for that title.
 *
 * Returns: { ok: true, data: { slug, malId, anilistId, title } }
 *
 * Examples:
 *   /api/anime/by-mal/21  (One Piece)
 *   /api/anime/by-mal/16498  (Attack on Titan S2)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const malId = parseInt(id, 10);

    if (isNaN(malId) || malId <= 0) {
      return NextResponse.json({ ok: false, message: 'Invalid MAL ID' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const refresh = searchParams.get('refresh') === '1';
    const cacheKey = `by-mal:${malId}`;

    const data = refresh
      ? await resolveByMalId(malId)
      : await getOrSet(cacheKey, () => resolveByMalId(malId), CACHE_TTL.ANIME);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/anime/by-mal/[id]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

async function resolveByMalId(malId: number) {
  // AniList can search by MAL ID via idMal field
  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        id
        idMal
        title { romaji english native }
      }
    }
  `;

  const resp = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { idMal: malId } }),
  });

  if (!resp.ok) throw new Error(`AniList API error: ${resp.status}`);

  const json = (await resp.json()) as {
    data?: { Media?: { id: number; idMal?: number; title: { romaji?: string; english?: string; native?: string } } };
  };

  const media = json?.data?.Media;
  if (!media) throw new Error(`MAL ID ${malId} not found via AniList`);

  const anilistId = media.id;
  const searchTitle = media.title.english || media.title.romaji || '';

  // Search anikoto for the title
  const slug = await searchAnikotoSlug(searchTitle, media.title.romaji);

  return {
    malId,
    anilistId,
    slug,
    title: searchTitle || media.title.romaji,
    titleRomaji: media.title.romaji,
    titleNative: media.title.native,
    animeUrl: slug ? `/api/anime/${slug}` : null,
  };
}

async function searchAnikotoSlug(
  title: string,
  fallbackTitle?: string
): Promise<string | null> {
  const { scrapeSearch } = await import('@/lib/scrapers/search.scraper');

  for (const t of [title, fallbackTitle].filter(Boolean) as string[]) {
    try {
      const result = await scrapeSearch(t);
      if (result.results.length > 0) {
        return result.results[0].slug;
      }
    } catch {
      // try next
    }
  }

  return null;
}
