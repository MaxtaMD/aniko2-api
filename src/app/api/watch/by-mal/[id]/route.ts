import { NextResponse } from 'next/server';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { scrapeSearch } from '@/lib/scrapers/search.scraper';
import { scrapeWatch } from '@/lib/scrapers/watch.scraper';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/by-mal/[id]?ep=1
 *
 * Resolves MAL ID → slug internally, returns video sources directly.
 * No slug needed from client.
 *
 * Query params:
 *   ep  – episode number (default: 1)
 *
 * Examples:
 *   /api/watch/by-mal/21?ep=5
 *   /api/watch/by-mal/16498?ep=1
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
    const epNum = searchParams.get('ep') ?? '1';
    const refresh = searchParams.get('refresh') === '1';

    const cacheKey = `watch:by-mal:${malId}:${epNum}`;

    const data = refresh
      ? await resolveAndWatch(malId, epNum)
      : await getOrSet(cacheKey, () => resolveAndWatch(malId, epNum), CACHE_TTL.EPISODE);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/watch/by-mal/[id]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

async function resolveAndWatch(malId: number, epNum: string) {
  // 1. MAL ID → title via AniList (idMal field)
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

  // 2. title → anikoto slug
  const slug = await resolveSlug(searchTitle, media.title.romaji);
  if (!slug) throw new Error(`Could not find "${searchTitle}" on anikoto`);

  // 3. slug + ep → video sources
  const watchData = await scrapeWatch(slug, epNum);

  return {
    malId,
    anilistId: media.id,
    slug,
    ...watchData,
  };
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
