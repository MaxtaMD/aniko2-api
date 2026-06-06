import { NextResponse } from 'next/server';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { scrapeWatch } from '@/lib/scrapers/watch.scraper';
import { resolveSlug } from '@/lib/resolveSlug';

export const dynamic = 'force-dynamic';

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
  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
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
    body: JSON.stringify({ query, variables: { idMal: malId } }),
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
  if (!media) throw new Error(`MAL ID ${malId} not found via AniList`);

  const slug = await resolveSlug(
    media.title,
    malId,
    { type: media.format, year: media.seasonYear, episodes: media.episodes }
  );

  if (!slug) throw new Error(`Could not find "${media.title.english || media.title.romaji}" on anikototv`);

  const watchData = await scrapeWatch(slug, epNum);
  return { malId, anilistId: media.id, slug, ...watchData };
}
