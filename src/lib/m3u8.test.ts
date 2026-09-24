import { filterAdsFromM3U8, rewriteM3U8Urls } from './m3u8';

const BASE = 'https://v.example.com/20260101/abc/2000k/hls/index.m3u8';

function playlist(parts: (string[] | 'D')[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6'];
  for (const p of parts) {
    if (p === 'D') {
      lines.push('#EXT-X-DISCONTINUITY');
    } else {
      for (const seg of p) lines.push('#EXTINF:6.000000,', seg);
    }
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function segs(prefix: string, from: number, to: number, pad = 4, ext = '.ts') {
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${prefix}${String(i).padStart(pad, '0')}${ext}`);
  }
  return out;
}

function segmentsOf(m3u8: string): string[] {
  return m3u8.split('\n').filter((l) => l && !l.startsWith('#'));
}

describe('filterAdsFromM3U8', () => {
  it('removes ad groups served from a different path', () => {
    const out = filterAdsFromM3U8(
      playlist([
        segs('', 0, 20),
        'D',
        ['https://ad.example.com/x/ad1.ts', 'https://ad.example.com/x/ad2.ts'],
        'D',
        segs('', 21, 40),
      ]),
      BASE
    );
    expect(out).not.toContain('ad1.ts');
    expect(out).not.toContain('#EXT-X-DISCONTINUITY');
    expect(segmentsOf(out)).toEqual(segs('', 0, 40));
  });

  it('removes ad groups with the same path and name length but a different prefix', () => {
    const out = filterAdsFromM3U8(
      playlist([
        segs('8f2e1a', 0, 20, 6),
        'D',
        segs('c9b7d4', 0, 3, 6),
        'D',
        segs('8f2e1a', 21, 40, 6),
      ]),
      BASE
    );
    expect(segmentsOf(out)).toEqual(segs('8f2e1a', 0, 40, 6));
  });

  it('removes ad groups that break the segment sequence', () => {
    const out = filterAdsFromM3U8(
      playlist([
        segs('', 0, 20),
        'D',
        segs('', 900, 903),
        'D',
        segs('', 21, 40),
      ]),
      BASE
    );
    expect(segmentsOf(out)).toEqual(segs('', 0, 40));
  });

  it('removes pre-roll ads', () => {
    const out = filterAdsFromM3U8(
      playlist([
        ['https://ad.example.com/x/ad1.ts'],
        'D',
        segs('8f2e1a', 0, 40, 6),
      ]),
      BASE
    );
    expect(segmentsOf(out)).toEqual(segs('8f2e1a', 0, 40, 6));
  });

  it('keeps everything when segment names are random hashes', () => {
    const names = Array.from(
      { length: 30 },
      (_, i) => `${(i * 2654435761).toString(16).padStart(8, 'a')}.ts`
    );
    const out = filterAdsFromM3U8(
      playlist([
        names.slice(0, 10),
        'D',
        names.slice(10, 12),
        'D',
        names.slice(12),
      ]),
      BASE
    );
    expect(segmentsOf(out)).toEqual(names);
  });

  it('keeps long groups even if they look different', () => {
    const out = filterAdsFromM3U8(
      playlist([segs('', 0, 40), 'D', segs('part2_', 0, 40)]),
      BASE
    );
    expect(segmentsOf(out)).toHaveLength(82);
  });

  it('leaves master playlists alone apart from discontinuity tags', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n2000k/hls/index.m3u8';
    expect(filterAdsFromM3U8(master, BASE)).toBe(master);
  });
});

describe('rewriteM3U8Urls', () => {
  it('makes segment URLs absolute and proxies sub playlists', () => {
    const media = rewriteM3U8Urls(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"\n#EXTINF:6,\n0001.ts',
      BASE,
      (u) => `P:${u}`
    );
    expect(media).toContain(
      'URI="https://v.example.com/20260101/abc/2000k/hls/key.key"'
    );
    expect(media).toContain(
      'https://v.example.com/20260101/abc/2000k/hls/0001.ts'
    );

    const master = rewriteM3U8Urls(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/20260101/abc/2000k/hls/index.m3u8',
      'https://v.example.com/20260101/abc/index.m3u8',
      (u) => `P:${u}`
    );
    expect(master).toContain(
      'P:https://v.example.com/20260101/abc/2000k/hls/index.m3u8'
    );
  });
});
