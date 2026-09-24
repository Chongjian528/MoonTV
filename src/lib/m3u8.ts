/**
 * M3U8 去广告相关工具，前端 hls.js loader 与服务端 /api/proxy/m3u8 共用
 */

// 被判定为广告的分段组最长时长（秒），超过则视为正片不做删除，避免误删
const MAX_AD_GROUP_DURATION = 120;

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
  duration: number;
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
 * 1. 按 #EXT-X-DISCONTINUITY 将分段分组，删除与正片路径/命名规则不一致、
 *    或打断正片序号连续性的短分段组（插播广告）
 * 2. 移除所有 #EXT-X-DISCONTINUITY 标识
 */
export function filterAdsFromM3U8(content: string, baseUrl?: string): string {
  if (!content) return '';

  const lines = content.split('\n');

  // 主播放列表（仅包含子列表）不需要处理分段
  if (!lines.some((l) => l.trim().startsWith('#EXTINF'))) {
    return lines.filter((l) => !l.includes('#EXT-X-DISCONTINUITY')).join('\n');
  }

  const header: string[] = [];
  const footer: string[] = [];
  const groups: SegmentGroup[] = [];
  let current: SegmentGroup = { lines: [], segments: [], duration: 0 };
  let seenSegment = false;
  let pendingDuration = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.includes('#EXT-X-DISCONTINUITY')) {
      if (current.lines.length) groups.push(current);
      current = { lines: [], segments: [], duration: 0 };
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
      current.duration += pendingDuration;
      pendingDuration = 0;
    }
  }
  if (current.lines.length) groups.push(current);

  const lenSig = dominantSignature(groups, (seg) => seg.lenSig);
  const prefixSig = dominantSignature(groups, (seg) => seg.prefixSig);

  const isAd = (g: SegmentGroup, i: number): boolean => {
    if (groups.length <= 1 || g.segments.length === 0) return false;
    if (g.duration > MAX_AD_GROUP_DURATION) return false;

    // 1. 路径或命名规则与正片不一致
    if (lenSig && !g.segments.some((seg) => seg.lenSig === lenSig)) return true;
    if (prefixSig && !g.segments.some((seg) => seg.prefixSig === prefixSig)) {
      return true;
    }

    // 2. 序号不连续：前后两组正片序号首尾相接，而本组序号插不进去
    const prev = groups[i - 1];
    const next = groups[i + 1];
    if (prev && next) {
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
  const body = groups.flatMap((g, i) =>
    !isAd(g, i) ? g.lines : g.lines.filter((l) => isSegmentTag(l.trim()))
  );

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
