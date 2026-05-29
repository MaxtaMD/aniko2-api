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

async function resolveAndWatch(anilistId: number, ep: string) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        title { romaji english }
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
    data?: { Media?: { id: number; idMal?: number; title: { romaji?: string; english?: string } } };
  };

  const media = json?.data?.Media;
  if (!media) throw new Error(`AniList ID ${anilistId} not found`);

  const searchTitle = media.title.english || media.title.romaji || '';
  const slug = await resolveSlug(searchTitle, media.title.romaji);
  if (!slug) throw new Error(`Could not find "${searchTitle}" on anikoto`);

  const watchData = await scrapeWatch(slug, ep);

  return { anilistId, malId: media.idMal ?? undefined, slug, ...watchData };
}

async function resolveSlug(title: string, fallback?: string): Promise<string | null> {
  for (const t of [title, fallback].filter(Boolean) as string[]) {
    try {
      const result = await scrapeSearch(t);
      if (result.results.length > 0) return result.results[0].slug;
    } catch { /* try next */ }
  }
  return null;
}
