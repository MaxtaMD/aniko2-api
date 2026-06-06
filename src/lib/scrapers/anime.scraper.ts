import * as cheerio from 'cheerio';
import { fetchPage } from '../fetcher';
import { AnimeDetail, Episode, AnimeEpisodes } from '../types';
import { BASE_URL } from '../constants';

// ─── AniList / MAL ID Resolution ─────────────────────────────────────────────

/**
 * Extract MAL ID from the anime detail page.
 * anikoto.net detail pages often have a MAL link in the .bmeta section.
 */
function extractMalId($: cheerio.CheerioAPI): number | undefined {
  let malId: number | undefined;

  // Try: a link to myanimelist.net
  $('a[href*="myanimelist.net"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const match = href.match(/myanimelist\.net\/anime\/(\d+)/);
    if (match) malId = parseInt(match[1], 10);
  });

  return malId;
}

/**
 * Fetch AniList ID and MAL ID by searching with the anime title.
 * Uses AniList GraphQL API — free, no auth required.
 */
async function fetchAnilistIds(
  title: string,
  titleJp?: string,
  titleNative?: string
): Promise<{ anilistId?: number; malId?: number }> {
  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        idMal
        title { romaji english native }
      }
    }
  `;

  const searches = [...new Set([title, titleJp, titleNative].filter(Boolean) as string[])];

  for (const search of searches) {
    try {
      const resp = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: { search } }),
      });

      if (!resp.ok) continue;

      const json = (await resp.json()) as {
        data?: { Media?: { id?: number; idMal?: number } };
        errors?: unknown[];
      };

      const media = json?.data?.Media;
      if (media?.id) {
        return {
          anilistId: media.id ?? undefined,
          malId: media.idMal ?? undefined,
        };
      }
    } catch {
      // silently continue to next search term
    }
  }

  return {};
}

// ─── Anime Detail ─────────────────────────────────────────────────────────────

export async function scrapeAnimeDetail(slug: string): Promise<AnimeDetail> {
  const $ = await fetchPage(`/watch/${slug}`);

  const $main = $('#watch-main');
  const animeId = $main.attr('data-id') ?? '';
  const animeUrl = $main.attr('data-url') ?? '';

  const $binfo = $('.binfo');
  const $poster = $binfo.find('.poster img');
  const $info = $binfo.find('.info');

  // Alternative titles
  const altRaw = $info.find('.names').text().trim();
  const alternativeTitles = altRaw
    ? altRaw
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Genres
  const genres: string[] = [];
  $info.find('.bmeta .meta div').each((_, el) => {
    const $el = $(el);
    const label = $el.clone().children().remove().end().text().trim();
    if (label.toLowerCase().startsWith('genre')) {
      $el.find('a').each((__, a) => {
        genres.push($(a).text().trim());
      });
    }
  });

  // Studios & Producers
  const studios: string[] = [];
  const producers: string[] = [];
  $info.find('.bmeta .meta div').each((_, el) => {
    const $el = $(el);
    const label = $el.clone().children().remove().end().text().trim().toLowerCase();
    if (label.startsWith('studio')) {
      $el.find('a').each((__, a) => { studios.push($(a).text().trim()); });
    }
    if (label.startsWith('producer')) {
      $el.find('a').each((__, a) => { producers.push($(a).text().trim()); });
    }
  });

  // Meta helper
  function getMeta(labelPrefix: string): string | undefined {
    let result: string | undefined;
    $info.find('.bmeta .meta div').each((_, el) => {
      const $el = $(el);
      const labelText = $el.clone().children().remove().end().text().trim();
      if (labelText.toLowerCase().startsWith(labelPrefix.toLowerCase())) {
        result = $el.find('span, a').first().text().trim() || $el.find('span').text().trim();
      }
    });
    return result || undefined;
  }

  const malScoreRaw = $info.find('.bmeta .meta div').filter((_, el) => {
    return $(el).clone().children().remove().end().text().trim().toLowerCase().startsWith('mal');
  }).find('span').text().trim();

  const epCountRaw = $info.find('.bmeta .meta div').filter((_, el) => {
    return $(el).clone().children().remove().end().text().trim().toLowerCase().startsWith('episode');
  }).find('span').text().trim();

  const title = $info.find('h1.title').text().trim();
  const titleJp = $info.find('h1.title').attr('data-jp')?.trim();

  // Try to get MAL ID from page HTML first, then fallback to AniList API
  const malIdFromPage = extractMalId($);

  const episodes = await scrapeAnimeEpisodes(slug);

  // Fetch AniList + MAL IDs concurrently (non-blocking — won't throw)
  const { anilistId, malId: malIdFromAnilist } = await fetchAnilistIds(title, titleJp).catch(
    (): { anilistId?: number; malId?: number } => ({})
  );

  const malId = malIdFromPage ?? malIdFromAnilist;

  return {
    id: animeId,
    slug,
    title,
    titleJp,
    alternativeTitles,
    image: $poster.attr('src') ?? '',
    rating: $info.find('.meta.icons .rating').text().trim() || undefined,
    quality: $info.find('.meta.icons .quality').text().trim() || undefined,
    hasDub: $info.find('.meta.icons .dub').length > 0,
    hasSub: $info.find('.meta.icons .sub').length > 0,
    synopsis: $info.find('.synopsis .content').text().trim() || $info.find('.synopsis').text().trim() || undefined,
    type: getMeta('type'),
    premiered: getMeta('premiered'),
    aired: getMeta('aired'),
    status: getMeta('status'),
    genres,
    malScore: malScoreRaw ? parseFloat(malScoreRaw) : undefined,
    malId,
    anilistId,
    duration: getMeta('duration'),
    episodeCount: epCountRaw ? parseInt(epCountRaw, 10) : undefined,
    studios,
    producers,
    watchUrl: animeUrl || `${BASE_URL}/watch/${slug}`,
    episodes,
  };
}

// ─── Episode List ─────────────────────────────────────────────────────────────

/**
 * Scrapes the episode list from the watch page embedded episode section.
 * The site loads episodes dynamically; we also try the static HTML as a fallback.
 */
export async function scrapeAnimeEpisodes(
  slug: string,
  startEpisode?: number,
  endEpisode?: number
): Promise<AnimeEpisodes> {
  let $ = await fetchPage(`/watch/${slug}`);
  const animeId = $('#watch-main').attr('data-id') ?? '';

  // If the episodes container is empty or loading, fetch via AJAX
  if (animeId && $('#w-episodes a').length === 0) {
    try {
      const { fetchJson } = await import('../fetcher');
      const data = await fetchJson<{ status: boolean; result: string }>(`/ajax/episode/list/${animeId}`);
      if (data && data.result) {
        // Load the HTML chunk from AJAX into cheerio
        const ajaxDoc = cheerio.load(data.result);
        $('#w-episodes').html(ajaxDoc.html());
      }
    } catch (err) {
      console.error('Failed to fetch episodes via AJAX:', err);
    }
  }

  const allEpisodes: Episode[] = [];

  // Episodes rendered as <li> inside #w-episodes
  $('#w-episodes ul.ep-range li a, #w-episodes a[href], #w-episodes a[data-num]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    // Sometimes it's an anchor without href but with data-num on the watch page
    if (!href.includes('/watch/') && !$el.attr('data-num')) return;

    const epNum = $el.attr('data-num') 
      || $el.find('.number, .d-title, span').first().text().trim()
      || href.split('/ep-')[1]
      || '';

    allEpisodes.push({
      number: epNum || String(allEpisodes.length + 1),
      title: $el.attr('title')?.trim() || undefined,
      href,
      id: $el.attr('data-id') ?? undefined,
      dataIds: $el.attr('data-ids') ?? $el.attr('data-id') ?? undefined,
      hasDub: $el.find('.ep-status.dub').length > 0 || $el.text().toLowerCase().includes('dub') || $el.attr('data-dub') === '1',
      hasSub: $el.find('.ep-status.sub').length > 0 || $el.text().toLowerCase().includes('sub') || $el.attr('data-sub') === '1',
    });
  });

  let filteredEpisodes = allEpisodes;

  // Apply range filtering if startEpisode and endEpisode are provided
  if (startEpisode !== undefined && endEpisode !== undefined) {
    filteredEpisodes = allEpisodes.filter((ep) => {
      const num = parseInt(ep.number, 10);
      return num >= startEpisode && num <= endEpisode;
    });
  }

  return { animeId, slug, episodes: filteredEpisodes };
}
