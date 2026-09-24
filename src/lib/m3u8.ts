/**
 * M3U8 去广告相关工具，前端 hls.js loader 与服务端 /api/proxy/m3u8 共用
 */

// 被判定为广告的分段组最长时长（秒），超过则视为正片不做删除，避免误删
const MAX_AD_GROUP_DURATION = 120;

/**
 * 已知广告的切片时长指纹（保留两位小数，每项为连续的若干个分组）。
 * 各资源站会把同一段广告插入到不同影片，当广告与正片的路径、帧率都相同时
 * （如电影天堂、如意、量子），只能靠时长指纹识别。
 * 以下均为抽帧确认过的博彩广告；较短的指纹需与相邻分组一起匹配，避免误删正片
 */
const KNOWN_AD_FINGERPRINTS: string[][] = [
  // 非凡、电影天堂
  ['5.57,3.2', '5.37,3.33,1.6'],
  ['5.57,2.93,5.7', '3.33,1.53'],
  ['6.67,2.13', '3.23,3.73'],
  ['6.67', '2.13,3.23,3.73'],
  ['4.87,3.33,5.6,2.87,2.97'],
  ['6.96,4,2.56,3.84'],
  // 如意
  ['4,5.48,2.92,4,4.32,1.28'],
  ['4,4,4,4,4,1'],
  // 量子
  ['4,4,4,4,4,4,1.7'],
  // iKun、魔都
  ['3,3,5,3,3,0.64'],
  ['3.33,1.67,1.67,2.93,1.67,1.67,1.67,1.67,1.3'],
];

function durationFingerprint(durations: number[]): string {
  return durations.map((d) => String(Math.round(d * 100) / 100)).join(',');
}

// 返回命中已知广告指纹的分组下标
function matchKnownAds(groups: SegmentGroup[]): Set<number> {
  const fps = groups.map((g) => durationFingerprint(g.durations));
  const hits = new Set<number>();
  for (const pattern of KNOWN_AD_FINGERPRINTS) {
    for (let i = 0; i + pattern.length <= fps.length; i++) {
      if (pattern.every((p, k) => fps[i + k] === p)) {
        pattern.forEach((_, k) => hits.add(i + k));
      }
    }
  }
  return hits;
}

function resolveUrl(uri: string, baseUrl?: string): string {
  if (!baseUrl) return uri;
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

interface SegmentInfo {
  // 所在目录 + 文件名长度
  lenSig: string;
  // 所在目录 + 去掉末尾序号后的文件名（如 abc123000045.ts -> abc123#.ts）
  prefixSig: string;
  // 文件名末尾序号，没有则为 null
  seq: number | null;
}

// 分段特征：广告分段通常来自不同路径/命名规则，或打断正片分段的序号连续性
function segmentInfo(uri: string, baseUrl?: string): SegmentInfo {
  const full = resolveUrl(uri, baseUrl).split('?')[0];
  const idx = full.lastIndexOf('/');
  const dir = full.slice(0, idx + 1);
  const name = full.slice(idx + 1);
  const m = name.match(/^(.*?)(\d+)(\.[a-z0-9]+)?$/i);
  return {
    lenSig: `${dir}|${name.length}`,
    prefixSig: m ? `${dir}|${m[1]}#${m[3] || ''}` : `${dir}|${name}`,
    seq: m && m[2].length <= 15 ? parseInt(m[2], 10) : null,
  };
}

interface SegmentGroup {
  lines: string[];
  segments: SegmentInfo[];
  durations: number[];
  duration: number;
}

// 常见帧率对应的单帧时长；切片时长通常是帧时长的整数倍
const FRAME_STEPS = [1 / 25, 1 / 30, 1 / 24, 1001 / 24000, 1001 / 30000];
// #EXTINF 一般保留三位小数，允许的舍入误差
const FRAME_TOLERANCE = 0.0006;
// 正片时长至少有此比例落在某个帧网格上，才启用帧率判断
const FRAME_GRID_COVERAGE = 0.9;

function onFrameGrid(duration: number, step: number): boolean {
  const k = Math.round(duration / step);
  return k > 0 && Math.abs(duration - k * step) <= FRAME_TOLERANCE;
}

/**
 * 找出覆盖正片的帧网格。插播广告常与正片帧率不同（如正片 25fps、广告 30fps），
 * 其切片时长（5.567、3.333 等）无法落在正片帧网格上
 */
function mainFrameSteps(groups: SegmentGroup[]): number[] {
  let total = 0;
  const covered = FRAME_STEPS.map(() => 0);
  for (const g of groups) {
    for (const d of g.durations) {
      total += d;
      FRAME_STEPS.forEach((step, i) => {
        if (onFrameGrid(d, step)) covered[i] += d;
      });
    }
  }
  if (total <= 0) return [];
  return FRAME_STEPS.filter(
    (_, i) => covered[i] / total >= FRAME_GRID_COVERAGE && covered[i] < total
  );
}

// 找出按时长占比最大的特征；占比不足一半时说明该特征不稳定（如文件名为随机哈希），不予采用
function dominantSignature(
  groups: SegmentGroup[],
  pick: (s: SegmentInfo) => string
): string | null {
  const durationBySig = new Map<string, number>();
  let total = 0;
  for (const g of groups) {
    const per = g.segments.length ? g.duration / g.segments.length : 0;
    for (const seg of g.segments) {
      const sig = pick(seg);
      durationBySig.set(sig, (durationBySig.get(sig) || 0) + per);
      total += per;
    }
  }
  let mainSig: string | null = null;
  let max = -1;
  durationBySig.forEach((d, sig) => {
    if (d > max) {
      max = d;
      mainSig = sig;
    }
  });
  return total > 0 && max / total >= 0.5 ? mainSig : null;
}

function firstSeq(g: SegmentGroup): number | null {
  return g.segments.length ? g.segments[0].seq : null;
}

function lastSeq(g: SegmentGroup): number | null {
  return g.segments.length ? g.segments[g.segments.length - 1].seq : null;
}

/**
 * 过滤 M3U8 中的广告：
 * 1. 按 #EXT-X-DISCONTINUITY 将分段分组，删除与正片路径/命名规则、帧率不一致，
 *    或打断正片序号连续性的短分段组（插播广告）
 * 2. 默认移除所有 #EXT-X-DISCONTINUITY 标识（hls.js 下的原有行为）；
 *    keepDiscontinuity 为 true 时保留正片分组之间的标识，供原生 HLS 播放使用，
 *    避免时间戳跳变导致 Safari 卡顿
 */
export function filterAdsFromM3U8(
  content: string,
  baseUrl?: string,
  options: { keepDiscontinuity?: boolean } = {}
): string {
  if (!content) return '';

  const lines = content.split('\n');

  // 主播放列表（仅包含子列表）不需要处理分段
  if (!lines.some((l) => l.trim().startsWith('#EXTINF'))) {
    return lines.filter((l) => !l.includes('#EXT-X-DISCONTINUITY')).join('\n');
  }

  const header: string[] = [];
  const footer: string[] = [];
  const groups: SegmentGroup[] = [];
  let current: SegmentGroup = {
    lines: [],
    segments: [],
    durations: [],
    duration: 0,
  };
  let seenSegment = false;
  let pendingDuration = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.includes('#EXT-X-DISCONTINUITY')) {
      if (current.lines.length) groups.push(current);
      current = { lines: [], segments: [], durations: [], duration: 0 };
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      footer.push(rawLine);
      continue;
    }

    if (!seenSegment && !line.startsWith('#EXTINF') && !isSegmentTag(line)) {
      header.push(rawLine);
      continue;
    }

    seenSegment = true;
    current.lines.push(rawLine);

    if (line.startsWith('#EXTINF')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line && !line.startsWith('#')) {
      current.segments.push(segmentInfo(line, baseUrl));
      current.durations.push(pendingDuration);
      current.duration += pendingDuration;
      pendingDuration = 0;
    }
  }
  if (current.lines.length) groups.push(current);

  const lenSig = dominantSignature(groups, (seg) => seg.lenSig);
  const prefixSig = dominantSignature(groups, (seg) => seg.prefixSig);
  const frameSteps = mainFrameSteps(groups);
  const fingerprintAds = matchKnownAds(groups);
  // 仅当切片文件名确实按序号递增时才启用序号规则，避免随机哈希文件名末尾数字巧合
  let seqPairs = 0;
  let seqHits = 0;
  for (const g of groups) {
    for (let j = 1; j < g.segments.length; j++) {
      const a = g.segments[j - 1].seq;
      const b = g.segments[j].seq;
      seqPairs++;
      if (a !== null && b === a + 1) seqHits++;
    }
  }
  const sequentialNames = seqPairs > 0 && seqHits / seqPairs >= 0.8;

  const isAd = (g: SegmentGroup, i: number): boolean => {
    if (groups.length <= 1 || g.segments.length === 0) return false;
    if (g.duration > MAX_AD_GROUP_DURATION) return false;

    // 0. 已知广告的时长指纹
    if (fingerprintAds.has(i)) return true;

    // 1. 路径或命名规则与正片不一致
    if (lenSig && !g.segments.some((seg) => seg.lenSig === lenSig)) return true;
    if (prefixSig && !g.segments.some((seg) => seg.prefixSig === prefixSig)) {
      return true;
    }

    // 2. 帧率与正片不一致：一半以上时长的切片落不到正片帧网格上
    for (const step of frameSteps) {
      const off = g.durations
        .filter((d) => !onFrameGrid(d, step))
        .reduce((a, b) => a + b, 0);
      if (off * 2 >= g.duration) return true;
    }

    // 3. 序号不连续：前后两组正片序号首尾相接，而本组序号插不进去
    const prev = groups[i - 1];
    const next = groups[i + 1];
    if (sequentialNames && prev && next) {
      const prevLast = lastSeq(prev);
      const nextFirst = firstSeq(next);
      const first = firstSeq(g);
      if (
        prevLast !== null &&
        nextFirst !== null &&
        nextFirst === prevLast + 1 &&
        first !== prevLast + 1
      ) {
        return true;
      }
    }
    return false;
  };

  // 广告组内的 KEY/MAP 标签仍需保留，后续正片分段可能沿用
  const body: string[] = [];
  let keptGroups = 0;
  groups.forEach((g, i) => {
    if (isAd(g, i)) {
      body.push(...g.lines.filter((l) => isSegmentTag(l.trim())));
      return;
    }
    if (options.keepDiscontinuity && keptGroups > 0) {
      body.push('#EXT-X-DISCONTINUITY');
    }
    body.push(...g.lines);
    keptGroups++;
  });

  return [...header, ...body, ...footer].join('\n');
}

function isSegmentTag(line: string): boolean {
  return (
    line.startsWith('#EXT-X-KEY') ||
    line.startsWith('#EXT-X-MAP') ||
    line.startsWith('#EXT-X-BYTERANGE')
  );
}

/**
 * 将 M3U8 内的相对地址改写为绝对地址；子播放列表地址交给 rewritePlaylist 处理
 */
export function rewriteM3U8Urls(
  content: string,
  baseUrl: string,
  rewritePlaylist: (absUrl: string) => string
): string {
  const lines = content.split('\n');
  const isMaster = lines.some((l) => l.trim().startsWith('#EXT-X-STREAM-INF'));

  return lines
    .map((rawLine) => {
      const line = rawLine.trim();
      if (!line) return rawLine;

      if (line.startsWith('#')) {
        // 处理标签中的 URI="..."（密钥、初始化分段、音轨/字幕子列表等）
        return rawLine.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          const isPlaylist =
            line.startsWith('#EXT-X-MEDIA') ||
            line.startsWith('#EXT-X-I-FRAME-STREAM-INF');
          return `URI="${isPlaylist ? rewritePlaylist(abs) : abs}"`;
        });
      }

      const abs = resolveUrl(line, baseUrl);
      return isMaster ? rewritePlaylist(abs) : abs;
    })
    .join('\n');
}
