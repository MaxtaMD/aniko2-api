import { NextResponse } from 'next/server';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

/**
 * GET /api/anime/by-anilist/[id]
 *
 * Resolves an AniList anime ID to an anikoto slug by searching AniList GraphQL
 * for the title, then searching anikoto for that title.
 *
 * Returns: { ok: true, data: { slug, anilistId, title } }
 *
 * Examples:
 *   /api/anime/by-anilist/21  (One Piece)
 *   /api/anime/by-anilist/16498  (Attack on Titan)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const anilistId = parseInt(id, 10);

    if (isNaN(anilistId) || anilistId <= 0) {
      return NextResponse.json({ ok: false, message: 'Invalid AniList ID' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const refresh = searchParams.get('refresh') === '1';
    const cacheKey = `by-anilist:${anilistId}`;

    const data = refresh
      ? await resolveByAnilistId(anilistId)
      : await getOrSet(cacheKey, () => resolveByAnilistId(anilistId), CACHE_TTL.ANIME);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/anime/by-anilist/[id]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

async function resolveByAnilistId(anilistId: number) {
  // 1. Fetch title from AniList
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
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
    data?: { Media?: { id: number; idMal?: number; title: { romaji?: string; english?: string; native?: string } } };
  };

  const media = json?.data?.Media;
  if (!media) throw new Error(`AniList ID ${anilistId} not found`);

  const searchTitle = media.title.english || media.title.romaji || '';
  const malId = media.idMal ?? undefined;

  // 2. Search anikoto for the title
  const slug = await searchAnikotoSlug(searchTitle, media.title.romaji);

  return {
    anilistId,
    malId,
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
