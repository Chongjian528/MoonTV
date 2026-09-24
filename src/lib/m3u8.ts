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

// 分段特征：所在目录 + 文件名长度，广告分段通常来自不同路径/命名规则
function segmentSignature(uri: string, baseUrl?: string): string {
  const full = resolveUrl(uri, baseUrl).split('?')[0];
  const idx = full.lastIndexOf('/');
  const dir = full.slice(0, idx + 1);
  const name = full.slice(idx + 1);
  return `${dir}|${name.length}`;
}

interface SegmentGroup {
  lines: string[];
  signatures: string[];
  duration: number;
}

/**
 * 过滤 M3U8 中的广告：
 * 1. 按 #EXT-X-DISCONTINUITY 将分段分组，删除与正片特征不一致的短分段组（插播广告）
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
  let current: SegmentGroup = { lines: [], signatures: [], duration: 0 };
  let seenSegment = false;
  let pendingDuration = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.includes('#EXT-X-DISCONTINUITY')) {
      if (current.lines.length) groups.push(current);
      current = { lines: [], signatures: [], duration: 0 };
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
      current.signatures.push(segmentSignature(line, baseUrl));
      current.duration += pendingDuration;
      pendingDuration = 0;
    }
  }
  if (current.lines.length) groups.push(current);

  // 按特征统计时长，时长最长的即为正片特征
  const durationBySig = new Map<string, number>();
  for (const g of groups) {
    const per = g.signatures.length ? g.duration / g.signatures.length : 0;
    for (const sig of g.signatures) {
      durationBySig.set(sig, (durationBySig.get(sig) || 0) + per);
    }
  }
  let mainSig = '';
  let maxDuration = -1;
  durationBySig.forEach((d, sig) => {
    if (d > maxDuration) {
      maxDuration = d;
      mainSig = sig;
    }
  });

  const isMain = (g: SegmentGroup) =>
    groups.length <= 1 ||
    !mainSig ||
    g.signatures.length === 0 ||
    g.signatures.includes(mainSig) ||
    g.duration > MAX_AD_GROUP_DURATION;

  // 广告组内的 KEY/MAP 标签仍需保留，后续正片分段可能沿用
  const body = groups.flatMap((g) =>
    isMain(g) ? g.lines : g.lines.filter((l) => isSegmentTag(l.trim()))
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
