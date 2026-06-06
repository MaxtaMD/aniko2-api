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
    const anilistId = parseInt(id, 10);
    if (isNaN(anilistId) || anilistId <= 0) {
      return NextResponse.json({ ok: false, message: 'Invalid AniList ID' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const epNum = searchParams.get('ep') ?? '1';
    const refresh = searchParams.get('refresh') === '1';
    const cacheKey = `watch:by-anilist:${anilistId}:${epNum}`;

    const data = refresh
      ? await resolveAndWatch(anilistId, epNum)
      : await getOrSet(cacheKey, () => resolveAndWatch(anilistId, epNum), CACHE_TTL.EPISODE);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/watch/by-anilist/[id]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

async function resolveAndWatch(anilistId: number, epNum: string) {
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

  const slug = await resolveSlug(
    media.title,
    media.idMal,
    { type: media.format, year: media.seasonYear, episodes: media.episodes }, anilistId
  );

  if (!slug) throw new Error(`Could not find "${media.title.english || media.title.romaji}" on anikototv`);

  const watchData = await scrapeWatch(slug, epNum);
  return { anilistId, malId: media.idMal ?? undefined, slug, ...watchData };
}
