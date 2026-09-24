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

// 非凡（ffzy）真实播放列表的分组时长：正片为 25fps（0.04 的整数倍），
// 且每约 20 秒就有一个 #EXT-X-DISCONTINUITY；广告为 30fps（1/30 的整数倍）
const FFZY_GROUPS: number[][] = [
  [6.48, 4, 4, 4, 4],
  [3.84, 4, 2.04, 3.92, 4.48],
  [3.36, 4.56, 5.4, 3.16, 2.88],
  [5.28, 3.8, 4.6, 2.96, 4.2],
  [6.16, 2.04, 4.08, 4, 4.28],
  [2.88, 4.68, 3.84, 3.68, 5],
  [4, 3.92, 4, 4, 4],
  [3.8, 4, 4.8, 2.24, 5.6],
  [2.32, 4.08, 3.88, 6.04, 4],
  [3.36, 3.24, 3.2, 4.28, 3.64],
  [5.4, 5.2, 2.12, 4.36, 4.44],
  [3.2, 4, 5.2, 2.12, 7.08],
  [3.12, 2.88, 4.04, 3.6, 4.16],
  [3.2, 5.72, 3.92, 4.12, 2.32],
  [5.6, 2.36, 3.88, 4.28, 4.32],
  [4.2, 3.36, 5.68, 2.56, 3.64],
  [5.28, 3.32, 3.48, 4.88, 3],
  [4.04, 4.24, 6.88, 1.04, 4.16],
  [4.56, 3.76, 4.16, 4, 4.56],
  [3.36, 4.68, 2.68, 4.04, 6.36],
  [2.16, 3.28, 4.24, 3.88],
  [5.567, 3.2],
  [5.367, 3.333, 1.6],
  [4.36, 6.56, 1.36, 4, 4.8],
  [2.96, 7.28, 1.88, 4, 4],
  [4, 3.12, 4.52, 3.88, 4],
  [4, 5.04, 3.32, 3.36, 3.96],
  [4.8, 3.84, 4.68, 2.52, 4.72],
  [3.36, 4, 4, 5.6, 2.32],
  [3.76, 4.92, 4.16, 6.4, 4],
  [0.88, 3.88, 6.56, 1.64, 4.4],
  [
    3.52, 3.64, 7.48, 0.76, 3.76, 4.64, 3.96, 4.76, 5.6, 2.2, 5.12, 1.8, 4.72,
    5.48, 4, 1.6, 4.68, 4.32, 4.8, 2.36, 4.12, 5, 3.88, 3.96, 4.72, 3.68, 3.64,
    5.08, 1.8, 6, 2.92, 3.08, 6.56, 4, 4, 1.92, 5.44, 2.04, 4.12, 7.28,
  ],
  [2.08, 3.24, 4.28, 4.64, 3.88],
  [3.96, 2.56, 3.96, 5.24, 4],
  [5.64, 2.36, 4.96, 3.52, 3.72],
  [2.92, 5.76, 2.04, 5.8, 2.08],
  [5.16, 3, 4.96, 2.96, 5.4],
  [4.24, 2.44, 5.96, 5.6, 0.88, 4.32, 4.2, 3, 6.2, 1.68],
  [4.04, 4.96, 3.16, 4.12, 4.96],
  [4.32, 6, 0.72, 4.84, 4.12],
  [2.72, 4.76, 4.68, 2.76, 4.28],
  [6.12, 1.72, 4.36, 5.36, 3.2],
  [3.36, 3.72, 4.92, 3.48, 6.28],
  [
    2.56, 3.24, 3.4, 5.08, 4.36, 3.72, 2.64, 7.44, 3.92, 3.12, 2.28, 4.6, 6.12,
    1.72, 3.4, 4.64, 3.96, 2.96, 6.8, 3.12,
  ],
  [3.12, 3.72, 4.04, 5.52, 2.64],
  [
    2.96, 7, 1.44, 4.96, 3.56, 4.32, 5.88, 3.96, 1.16, 4.84, 3.16, 6.28, 1.52,
    5.36, 5.4, 2.2, 4.04, 4.04, 3.04, 4.72, 4.64, 3.36, 3.24, 4.96, 4.52, 2.64,
    3.8, 4.52, 5.44, 5.76,
  ],
  [1.48, 2.84, 4.12, 3.92, 4.12],
  [4.32, 4.44, 3.32, 3.96, 6.48, 2.68, 3.72, 4.28, 2.92, 5.72],
  [4.6, 3.12, 2.72, 4, 4.84],
  [2.56, 4.28, 4.32, 6.48, 4],
  [4.12, 3.6, 4, 2.12, 6.44],
  [2.32, 4, 4.76, 2.24, 4],
  [
    4, 4.96, 3.96, 2.76, 4.6, 6.24, 4, 3.08, 3.24, 2.64, 5.08, 3.4, 4, 5.36,
    3.56,
  ],
  [5.92, 3, 4.68, 4, 4],
  [1.28, 6.64, 2.92, 2.56, 5.4],
  [3, 4, 4, 4, 4],
  [4, 4, 4, 4, 4],
  [4, 4, 4, 4, 4],
  [6.667, 2.133],
  [3.233, 3.733],
  [4, 4, 4, 4, 3.6],
];
const FFZY_AD_GROUPS = [21, 22, 58, 59];

function ffzyPlaylist(): { m3u8: string; names: string[][] } {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-TARGETDURATION:8',
  ];
  let n = 0;
  const names = FFZY_GROUPS.map((g) => {
    lines.push('#EXT-X-DISCONTINUITY');
    return g.map((d) => {
      const name = `${(++n * 2654435761)
        .toString(16)
        .padStart(32, 'f')}.ts?hash=${n}`;
      lines.push(`#EXTINF:${d.toFixed(3)},`, name);
      return name;
    });
  });
  lines.push('#EXT-X-ENDLIST');
  return { m3u8: lines.join('\n'), names };
}

describe('filterAdsFromM3U8 with ffzy playlist', () => {
  it('removes the 30fps ad groups and keeps all 25fps content', () => {
    const { m3u8, names } = ffzyPlaylist();
    const out = filterAdsFromM3U8(m3u8, BASE);
    const expected = names.filter((_, i) => !FFZY_AD_GROUPS.includes(i)).flat();
    expect(segmentsOf(out)).toEqual(expected);
    expect(out).not.toContain('#EXT-X-DISCONTINUITY');
  });

  it('keeps discontinuity tags between content groups for native playback', () => {
    const { m3u8 } = ffzyPlaylist();
    const out = filterAdsFromM3U8(m3u8, BASE, { keepDiscontinuity: true });
    const count = out.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY');
    expect(count).toHaveLength(FFZY_GROUPS.length - FFZY_AD_GROUPS.length - 1);
    expect(out.split('\n').slice(0, 6)).not.toContain('#EXT-X-DISCONTINUITY');
  });
});

// 按分组时长构造播放列表，切片名为随机哈希；返回每个分组的切片名
function groupedPlaylist(groups: number[][]): {
  m3u8: string;
  names: string[][];
} {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:8'];
  let n = 0;
  const names = groups.map((g, i) => {
    if (i > 0) lines.push('#EXT-X-DISCONTINUITY');
    return g.map((d) => {
      const name = `${(++n * 2246822519).toString(16).padStart(32, 'e')}.ts`;
      lines.push(`#EXTINF:${d},`, name);
      return name;
    });
  });
  lines.push('#EXT-X-ENDLIST');
  return { m3u8: lines.join('\n'), names };
}

function expectRemoved(groups: number[][], adGroups: number[]) {
  const { m3u8, names } = groupedPlaylist(groups);
  const out = filterAdsFromM3U8(m3u8, BASE);
  expect(segmentsOf(out)).toEqual(
    names.filter((_, i) => !adGroups.includes(i)).flat()
  );
}

// 以下时长均取自各资源站真实播放列表，广告分组已抽帧确认
describe('filterAdsFromM3U8 with known ad fingerprints', () => {
  // 30fps 正片，帧率规则无法区分
  const content30 = [
    [4.2, 4.6, 3.5, 4.167, 3.767],
    [4.9, 3.7, 4.467, 3.333, 4.833],
    [2.833, 5.333, 3.1, 3.333, 4.933],
    [3.333, 3.967, 4.067, 4.8, 3.533],
  ];

  it('removes 电影天堂 ads inside 30fps content', () => {
    expectRemoved(
      [
        ...content30.slice(0, 2),
        [5.567, 3.2],
        [5.367, 3.333, 1.6],
        ...content30.slice(2),
        [6.667],
        [2.133, 3.233, 3.733],
        content30[0],
      ],
      [2, 3, 6, 7]
    );
  });

  it('removes 如意 casino ads inside 25fps content', () => {
    const content25 = [
      [4.0, 4.0, 7.04, 4.0, 4.0, 2.4],
      [5.12, 4.0, 4.68, 1.16, 4.0, 4.0],
      [3.96, 4.0, 3.72, 4.0, 2.48, 4.0],
    ];
    expectRemoved(
      [
        content25[0],
        [4.0, 5.48, 2.92, 4.0, 4.32, 1.28],
        content25[1],
        [4.0, 4.0, 4.0, 4.0, 4.0, 1.0],
        content25[2],
      ],
      [1, 3]
    );
  });

  it('removes 量子 ads inside 23.976fps content', () => {
    const content = [4.004, 3.337, 4.004, 2.436, 4.004, 3.337, 4.004, 4.004];
    expectRemoved(
      [content, content, [4, 4, 4, 4, 4, 4, 1.7], content, content],
      [2]
    );
  });

  it('does not match short fingerprints on their own', () => {
    expectRemoved([...content30.slice(0, 2), [6.667], content30[2]], []);
  });
});

describe('filterAdsFromM3U8 sequence rule', () => {
  it('ignores digits that happen to end random hash names', () => {
    // 哈希文件名末尾恰好是 ...0 与 ...1，曾被误判为序号相连而删除中间的正片
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8'];
    const group = (names: string[]) => {
      for (const n of names) lines.push('#EXTINF:4.000,', n);
    };
    group(['f05d1645829d33f9d4.ts', '453780c7993e5292a16e0.ts']);
    lines.push('#EXT-X-DISCONTINUITY');
    group(['e54c4c58749d191d45ff.ts', 'e7c67e21dca36cf8752ad.ts']);
    lines.push('#EXT-X-DISCONTINUITY');
    group(['c794956470d92f64bc6d72098c8d28c1.ts', 'dc2f9c1440ec8446af1c3.ts']);
    const out = filterAdsFromM3U8(lines.join('\n'), BASE);
    expect(segmentsOf(out)).toHaveLength(6);
  });
});
