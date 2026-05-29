import { NextResponse } from 'next/server';
import { scrapeWatch } from '@/lib/scrapers/watch.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/[slug]?ep=1
 *
 * Retrieves video servers and iframe URLs for a specific episode of an anime.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { searchParams } = new URL(req.url);
    const resolvedParams = await params;
    const slug = resolvedParams.slug;
    const epNum = searchParams.get('ep') || '1';

    if (!slug) {
      return NextResponse.json({ ok: false, message: 'Missing slug' }, { status: 400 });
    }

    const cacheKey = `watch:${slug}:${epNum}`;
    const refresh = searchParams.get('refresh') === '1';

    const data = refresh
      ? await scrapeWatch(slug, epNum)
      : await getOrSet(cacheKey, () => scrapeWatch(slug, epNum), CACHE_TTL.EPISODE);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[GET /api/watch]`, message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
