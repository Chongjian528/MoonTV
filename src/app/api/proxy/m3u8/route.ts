import { NextResponse } from 'next/server';

import { filterAdsFromM3U8, rewriteM3U8Urls } from '@/lib/m3u8';

export const runtime = 'edge';

// 去广告 M3U8 代理：供不支持 hls.js（使用原生 HLS 播放）的浏览器使用，如 iOS Safari
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Invalid m3u8 URL' }, { status: 400 });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: upstream.statusText },
        { status: upstream.status }
      );
    }

    const text = await upstream.text();
    if (!text.trimStart().startsWith('#EXTM3U')) {
      return NextResponse.json({ error: 'Not a m3u8 file' }, { status: 400 });
    }

    // 以重定向后的最终地址作为相对路径基准
    const baseUrl = upstream.url || url;
    const filtered = filterAdsFromM3U8(text, baseUrl);
    const body = rewriteM3U8Urls(
      filtered,
      baseUrl,
      // 使用站内绝对路径，避免反向代理下 origin 协议/域名不一致
      (abs) => `/api/proxy/m3u8?url=${encodeURIComponent(abs)}`
    );

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Error fetching m3u8' }, { status: 500 });
  }
}
