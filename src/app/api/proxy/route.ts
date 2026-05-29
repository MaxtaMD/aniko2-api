import { NextResponse } from 'next/server';
import axios from 'axios';
import { DEFAULT_HEADERS } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get('url');
  const referer = searchParams.get('referer');

  if (!targetUrl) {
    return NextResponse.json({ ok: false, message: 'Missing url parameter' }, { status: 400 });
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      'Accept': '*/*',
    };

    if (referer) {
      headers['Referer'] = referer;
      headers['Origin'] = new URL(referer).origin;
    }

    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: 15_000,
    });

    const resHeaders = new Headers();
    const contentType = (response.headers['content-type'] as string) || 'application/octet-stream';
    resHeaders.set('Content-Type', contentType);
    resHeaders.set('Access-Control-Allow-Origin', '*');
    resHeaders.set('Cache-Control', 'no-cache');

    let responseData = response.data;

    // Rewrite internal URLs inside m3u8 playlists to pass through this proxy
    if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = Buffer.from(responseData).toString('utf-8');
      const baseUrl = new URL(targetUrl);
      
      const rewrittenText = text.split('\n').map(line => {
        // Rewrite URI attributes in tags (e.g. #EXT-X-KEY:URI="...", #EXT-X-MAP:URI="...", #EXT-X-MEDIA:URI="...")
        if (line.includes('URI=')) {
          line = line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
            let keyUrl = uri;
            if (!keyUrl.startsWith('http')) {
              keyUrl = new URL(keyUrl, baseUrl).toString();
            }
            const proxied = `/api/proxy?url=${encodeURIComponent(keyUrl)}&referer=${encodeURIComponent(referer || '')}`;
            return `URI="${proxied}"`;
          });
        }

        if (line.startsWith('#') || !line.trim()) return line;
        
        // This is a media segment or sub-playlist line
        let segmentUrl = line.trim();
        if (!segmentUrl.startsWith('http')) {
          segmentUrl = new URL(segmentUrl, baseUrl).toString();
        }
        
        // Return the proxied URL
        return `/api/proxy?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(referer || '')}`;
      }).join('\n');
      
      responseData = Buffer.from(rewrittenText, 'utf-8');
    }

    return new NextResponse(responseData, {
      status: 200,
      headers: resHeaders,
    });
  } catch (err: any) {
    const status = err.response?.status || 500;
    console.error(`[Proxy Error] ${status} on ${targetUrl}`);
    return NextResponse.json({ ok: false, message: 'Proxy request failed' }, { status });
  }
}
