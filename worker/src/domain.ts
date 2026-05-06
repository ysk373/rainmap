/** 純粋関数・定数（IO なし） */

/** JMA nowc の basetime/validtime（YYYYMMDDHHmmss, 日本時間想定）→ UTC ISO 8601 */
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
