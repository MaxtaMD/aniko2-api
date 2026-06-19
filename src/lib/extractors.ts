import axios from 'axios';
import { DEFAULT_HEADERS } from './constants';

export interface SubtitleTrack {
  file: string;
  label?: string;
  kind?: string;
  default?: boolean;
}

export interface ExtractedStream {
  m3u8: string;
  referer: string;
  tracks: SubtitleTrack[];
}

export async function extractMegaplay(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const host = new URL(embedUrl).host;
    const referer = 'https://' + host + '/';
    
    const { data: html } = await axios.get(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer }
    });
    
    const match = html.match(/<title>File ([0-9]+)/);
    if (!match) return null;
    
    const id = match[1];
    const { data } = await axios.get(`https://${host}/stream/getSources?id=${id}`, {
      headers: { ...DEFAULT_HEADERS, 'X-Requested-With': 'XMLHttpRequest', Referer: referer }
    });
    
    const m3u8 = data?.sources?.file;
    const tracks = data?.tracks || [];
    return m3u8 ? { m3u8, referer, tracks } : null;
  } catch (err) {
    console.error('Megaplay extraction failed:', err);
    return null;
  }
}

export async function extractMegacloud(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const origin = new URL(embedUrl).origin;
    const referer = origin + '/';
    
    const { data: html } = await axios.get(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer }
    });
    
    const match1 = html.match(/\b[a-zA-Z0-9]{48}\b/);
    const match2 = html.match(/\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/);
    const nonce = match1?.[0] || (match2 ? match2[1] + match2[2] + match2[3] : null);
    
    if (!nonce) return null;
    
    const sId = embedUrl.split('/e-1/')[1]?.split('?')[0] ?? embedUrl.split('/').pop()?.split('?')[0];
    const url = `${origin}/embed-2/v3/e-1/getSources?id=${sId}&_k=${nonce}`;
    
    const { data } = await axios.get(url, {
      headers: { ...DEFAULT_HEADERS, 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: referer }
    });
    
    const tracks = data?.tracks || [];
    
    if (!data.encrypted || (data.sources && data.sources[0]?.file.includes('.m3u8'))) {
      return data.sources[0]?.file ? { m3u8: data.sources[0].file, referer, tracks } : null;
    }
    
    const { data: keys } = await axios.get('https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json');
    const secret = keys['mega'];
    
    const decryptUrl = `https://megacloud-api-nine.vercel.app/?encrypted_data=${encodeURIComponent(data.sources[0].file)}&nonce=${encodeURIComponent(nonce)}&secret=${encodeURIComponent(secret)}`;
    const { data: decrypted } = await axios.get(decryptUrl);
    
    const m3u8 = (typeof decrypted === 'string' ? decrypted : JSON.stringify(decrypted)).match(/"file":"(.*?)"/)?.[1];
    return m3u8 ? { m3u8, referer, tracks } : null;
  } catch (err) {
    console.error('Megacloud extraction failed:', err);
    return null;
  }
}

// ── VidWish extractor ─────────────────────────────────────────────────────────
// VidWish uses the same getSources pattern as Megaplay but attr-based id extraction.
export async function extractVidWish(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const origin = new URL(embedUrl).origin;
    const referer = origin + '/';

    const { data: html } = await axios.get(embedUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        Referer: 'https://hianimes.re/',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10_000,
    });

    const idMatch = (html as string).match(/data-id="([^"]*)"/);
    if (!idMatch?.[1]) return null;

    const fileId = idMatch[1];
    const { data } = await axios.get(
      `${origin}/stream/getSources?id=${fileId}&id=${fileId}`,
      {
        headers: {
          ...DEFAULT_HEADERS,
          Referer: referer,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 10_000,
      }
    );

    const m3u8   = data?.sources?.file;
    const tracks = data?.tracks ?? [];
    return m3u8 ? { m3u8, referer, tracks } : null;
  } catch (err) {
    console.error('VidWish extraction failed:', err);
    return null;
  }
}

// ── Mapper servers (nekostream.site) ─────────────────────────────────────────
// Mirrors AniKotoAPI extractMapperServers — queries nekostream mapper API for
// alternative streaming providers (sub/dub) by MAL ID + slug + timestamp.
export interface MapperServer {
  provider: string;
  type: 'sub' | 'dub';
  url: string | null;
  download: string | null;
}

export async function extractMapperServers(
  malId: number | string,
  slug: string,
  timestamp: number | string
): Promise<MapperServer[]> {
  try {
    if (!Number.isFinite(Number(malId))) throw new Error('Invalid malId');
    if (!/^[a-zA-Z0-9-]+$/.test(slug)) throw new Error('Invalid slug');
    if (!Number.isFinite(Number(timestamp))) throw new Error('Invalid timestamp');

    const url = `https://mapper.nekostream.site/api/mal/${encodeURIComponent(malId)}/${encodeURIComponent(slug)}/${encodeURIComponent(timestamp)}`;
    const { data } = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 10_000 });

    const servers: MapperServer[] = [];
    if (data && typeof data === 'object') {
      for (const [provider, sources] of Object.entries(data as Record<string, { sub?: { url?: string; download?: string }; dub?: { url?: string; download?: string } }>)) {
        if (sources?.sub) servers.push({ provider, type: 'sub', url: sources.sub.url ?? null, download: sources.sub.download ?? null });
        if (sources?.dub) servers.push({ provider, type: 'dub', url: sources.dub.url ?? null, download: sources.dub.download ?? null });
      }
    }
    return servers;
  } catch {
    return [];
  }
}

export async function extractStreamUrl(embedUrl: string): Promise<ExtractedStream | null> {
  let currentUrl = embedUrl;
  let html = '';
  
  for (let i = 0; i < 3; i++) {
    try {
      let host = new URL(currentUrl).host;
      let referer = 'https://' + host + '/';
      let response;
      
      try {
        response = await axios.get(currentUrl, {
          headers: { ...DEFAULT_HEADERS, Referer: referer },
          timeout: 8000
        });
      } catch (err) {
        if (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click')) {
          const fallbackUrl = currentUrl
            .replace('vidwish.live', 'megaplay.buzz')
            .replace('megacloud.bloggy.click', 'megaplay.buzz');
          host = new URL(fallbackUrl).host;
          referer = 'https://' + host + '/';
          response = await axios.get(fallbackUrl, {
            headers: { ...DEFAULT_HEADERS, Referer: referer },
            timeout: 8000
          });
          currentUrl = fallbackUrl;
        } else {
          throw err;
        }
      }
      
      html = response.data;
      
      // If we got a 200 OK but it is actually a custom error page (e.g. 404 from Vidcloud)
      const isErrorPage = html.includes('Error -') || html.includes('error-container') || html.includes('doesn\'t exist');
      if (isErrorPage && (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click'))) {
        const fallbackUrl = currentUrl
          .replace('vidwish.live', 'megaplay.buzz')
          .replace('megacloud.bloggy.click', 'megaplay.buzz');
        host = new URL(fallbackUrl).host;
        referer = 'https://' + host + '/';
        response = await axios.get(fallbackUrl, {
          headers: { ...DEFAULT_HEADERS, Referer: referer },
          timeout: 8000
        });
        currentUrl = fallbackUrl;
        html = response.data;
      }
      
      // Check if there is an iframe src pointing to a stream/embed URL
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch) {
        const iframeSrc = iframeMatch[1];
        const resolvedUrl = new URL(iframeSrc, currentUrl).toString();
        if (resolvedUrl !== currentUrl) {
          currentUrl = resolvedUrl;
          continue;
        }
      }
    } catch (err) {
      console.error(`[extractStreamUrl] Failed to fetch or parse HTML for ${currentUrl}:`, err);
      if (!currentUrl.includes('megaplay.buzz') && (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click'))) {
        try {
          const fallbackUrl = currentUrl
            .replace('vidwish.live', 'megaplay.buzz')
            .replace('megacloud.bloggy.click', 'megaplay.buzz');
          currentUrl = fallbackUrl;
          i--;
          continue;
        } catch (e) {
          // ignore
        }
      }
    }
    break;
  }

  const host = new URL(currentUrl).hostname;

  // VidWish — dedicated extractor, fall back to megaplay if it fails
  if (host.includes('vidwish.live')) {
    const vw = await extractVidWish(currentUrl);
    if (vw) return vw;
    return extractMegaplay(currentUrl.replace('vidwish.live', 'megaplay.buzz'));
  }

  if (host.includes('megaplay.buzz')) {
    return extractMegaplay(currentUrl);
  }

  if (host.includes('megacloud.blog')) {
    return extractMegacloud(currentUrl);
  }

  return null;
}
