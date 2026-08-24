export interface LayoutInfo {
  /** 何列目か（0 始まり） */
  col: number;
  /** 同じ重なりグループの列数 */
  cols: number;
}

/**
 * 時間が重なる予定を Google カレンダーのように横に並べる。
 * 重なり合う予定のかたまり（クラスタ）ごとに列を割り当て、
 * クラスタ内の予定は同じ列数で幅を等分する。
 */
export function layoutEvents<T extends { start: number; end: number }>(
  events: T[]
): Map<T, LayoutInfo> {
  const result = new Map<T, LayoutInfo>();
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end);

  let cluster: T[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const cols = columnEnds.length;
    for (const ev of cluster) {
      const info = result.get(ev);
      if (info) info.cols = cols;
    }
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length && ev.start >= clusterEnd) flush();
    let col = columnEnds.findIndex((end) => end <= ev.start);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(ev.end);
    } else {
      columnEnds[col] = ev.end;
    }
    result.set(ev, { col, cols: 1 });
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  flush();
  return result;
}
