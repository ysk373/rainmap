/** 純粋関数・定数（IO なし） */

/**
 * JMA nowc の basetime/validtime（YYYYMMDDHHmmss）を
 * **日本標準時（JST）のローカル日時**として解釈し、UTC の ISO 8601（末尾 Z）へ変換する。
 * 防災気象の targetTimes／タイル URL の時刻はこの解釈で気象庁サイトの表示と整合する。
 */
export function jmaNowcTimeToUtcIso(jma: string): string {
  if (!/^\d{14}$/.test(jma)) {
    throw new Error(`invalid_jma_time:${jma}`);
  }
  const y = jma.slice(0, 4);
  const mo = jma.slice(4, 6);
  const d = jma.slice(6, 8);
  const h = jma.slice(8, 10);
  const mi = jma.slice(10, 12);
  const s = jma.slice(12, 14);
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid_jma_time_parse:${jma}`);
  }
  return new Date(ms).toISOString();
}

/** 日本域のおおよその coverage（EPSG:4326）— MVP 用の宣言範囲 */
export const JAPAN_COVERAGE_BBOX: [number, number, number, number] = [
  122.0, 24.0, 154.0, 46.0,
];

export type TargetTimeEntry = {
  basetime: string;
  validtime: string;
  elements?: string[];
};

export function parseTargetTimesJson(text: string, maxBytes = 512_000): TargetTimeEntry[] {
  const enc = new TextEncoder().encode(text);
  if (enc.byteLength > maxBytes) {
    throw new Error("target_times_too_large");
  }
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("target_times_not_array");
  }
  return data.map((row) => {
    if (!row || typeof row !== "object") throw new Error("target_times_row_invalid");
    const o = row as Record<string, unknown>;
    if (typeof o.basetime !== "string" || typeof o.validtime !== "string") {
      throw new Error("target_times_missing_fields");
    }
    return {
      basetime: o.basetime,
      validtime: o.validtime,
      elements: Array.isArray(o.elements) ? o.elements.map(String) : undefined,
    };
  });
}

export function frameIdForEntry(e: TargetTimeEntry): string {
  return `${e.basetime}_${e.validtime}`;
}

/** HRPNs コマの区分（メタ JSON の `frames[].role` に対応） */
export type FrameRole = "analysis" | "forecast";

/**
 * basetime と validtime が同一なら解析・実況寄り、異なれば短期予報コマ（N2 由来が典型）。
 */
export function frameRoleFromEntry(e: TargetTimeEntry): FrameRole {
  return e.basetime === e.validtime ? "analysis" : "forecast";
}

/**
 * N1 と N2 を統合する。同一 (basetime, validtime) が両方にあれば **N1 を優先**する。
 */
export function mergeTargetTimeEntries(
  n1: TargetTimeEntry[],
  n2: TargetTimeEntry[],
): TargetTimeEntry[] {
  const map = new Map<string, TargetTimeEntry>();
  for (const e of n2) {
    map.set(frameIdForEntry(e), e);
  }
  for (const e of n1) {
    map.set(frameIdForEntry(e), e);
  }
  return [...map.values()];
}

/**
 * 「これから雨が降りそうか」向けに初期表示するフレームを選ぶ。
 * 時系列は昇順（古い→新しい）、各 time は UTC の ISO 8601。
 *
 * ルール: サーバ時刻 now 以降で最も早いコマを選ぶ（短いリードの予報・解析）。
 * 一覧がすべて過去なら最後のコマ（直近の観測に相当）にフォールバック。
 */
export function defaultFrameIndexForUpcoming(
  frameTimesIsoUtc: readonly string[],
  nowMs: number,
): number {
  const n = frameTimesIsoUtc.length;
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) {
    const ms = Date.parse(frameTimesIsoUtc[i]!);
    if (!Number.isNaN(ms) && ms >= nowMs) return i;
  }
  return n - 1;
}

/** Web Mercator XYZ タイル (z/x/y) の WGS84 近似外接矩形（Leaflet/OSM と同系） */
export function xyzTileBoundsWgs84(
  z: number,
  x: number,
  y: number,
): { west: number; south: number; east: number; north: number } {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { west, south, east, north };
}

/** coverage.bbox [west,south,east,north] とタイル矩形が交差するか */
export function tileIntersectsCoverageBbox(
  z: number,
  x: number,
  y: number,
  bbox: readonly [number, number, number, number],
): boolean {
  const [cw, cs, ce, cn] = bbox;
  const t = xyzTileBoundsWgs84(z, x, y);
  return !(t.east < cw || t.west > ce || t.north < cs || t.south > cn);
}
