import { NextResponse } from 'next/server';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { scrapeSearch } from '@/lib/scrapers/search.scraper';
import { scrapeWatch } from '@/lib/scrapers/watch.scraper';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/mal/[id]/[ep]
 *
 * Examples:
 *   /api/watch/mal/21/1163
 *   /api/watch/mal/16498/1
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; ep: string }> }
) {
  try {
    const { id, ep } = await params;
    const malId = parseInt(id, 10);

    if (isNaN(malId) || malId <= 0) {
      return NextResponse.json({ ok: false, message: 'Invalid MAL ID' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const refresh = searchParams.get('refresh') === '1';
    const cacheKey = `watch:mal:${malId}:${ep}`;

    const data = refresh
      ? await resolveAndWatch(malId, ep)
      : await getOrSet(cacheKey, () => resolveAndWatch(malId, ep), CACHE_TTL.EPISODE);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/watch/mal/[id]/[ep]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

async function resolveAndWatch(malId: number, ep: string) {
  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        id
        idMal
        title { romaji english }
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
    data?: { Media?: { id: number; idMal?: number; title: { romaji?: string; english?: string } } };
  };

  const media = json?.data?.Media;
  if (!media) throw new Error(`MAL ID ${malId} not found via AniList`);

  const searchTitle = media.title.english || media.title.romaji || '';
  const slug = await resolveSlug(searchTitle, media.title.romaji);
  if (!slug) throw new Error(`Could not find "${searchTitle}" on anikoto`);

  const watchData = await scrapeWatch(slug, ep);

  return { malId, anilistId: media.id, slug, ...watchData };
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
