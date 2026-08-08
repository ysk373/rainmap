/**
 * 地点の降水ナウキャスト評価（HRPNs タイル画素サンプリング）。
 */

import {
  JAPAN_COVERAGE_BBOX,
  frameIdForEntry,
  frameRoleFromEntry,
  jmaNowcTimeToUtcIso,
  type FrameRole,
  type TargetTimeEntry,
} from "./domain";
import { decodePng } from "./png";
import { fetchUpstreamTile } from "./provider";

/** JMA 降水強度カラーに対応する代表値（mm/h）。index 0–1 は無降水（透明）。 */
export const HRPNS_INDEX_MMH: readonly number[] = [
  0, // 0 transparent
  0, // 1 transparent
  0.5, // 2 #f2f2ff  〜1
  3, // 3 #a0d2ff  1〜5
  7.5, // 4 #218cff  5〜10
  15, // 5 #0041ff 10〜20
  25, // 6 #faf500 20〜30
  40, // 7 #ff9900 30〜50
  65, // 8 #ff2800 50〜80
  90, // 9 #b40068 80〜
];

const HRPNS_RGB_MMH: ReadonlyArray<{ r: number; g: number; b: number; mmh: number }> = [
  { r: 0xf2, g: 0xf2, b: 0xff, mmh: 0.5 },
  { r: 0xa0, g: 0xd2, b: 0xff, mmh: 3 },
  { r: 0x21, g: 0x8c, b: 0xff, mmh: 7.5 },
  { r: 0x00, g: 0x41, b: 0xff, mmh: 15 },
  { r: 0xfa, g: 0xf5, b: 0x00, mmh: 25 },
  { r: 0xff, g: 0x99, b: 0x00, mmh: 40 },
  { r: 0xff, g: 0x28, b: 0x00, mmh: 65 },
  { r: 0xb4, g: 0x00, b: 0x68, mmh: 90 },
];

export type PrecipSample = {
  frame_id: string;
  time: string;
  role: FrameRole;
  intensity_mmh: number;
  intensity_label: string;
  raining: boolean;
};

export type PrecipAlertV1 = {
  contract_version: "1";
  lat: number;
  lon: number;
  zoom: number;
  horizon_minutes: number;
  min_intensity_mmh: number;
  stale: boolean;
  forecast_available: boolean;
  currently_raining: boolean;
  raining_soon: boolean;
  /** まもなく降り始める（いまは降っていない）とき true。n8n の通知条件に使いやすい */
  notify_recommended: boolean;
  eta_minutes: number | null;
  onset: PrecipSample | null;
  peak: PrecipSample | null;
  samples: PrecipSample[];
  map_url: string | null;
  tile_xy: { z: number; x: number; y: number; px: number; py: number };
  provider_attribution: string;
};

const STALE_AFTER_MS = 15 * 60 * 1000;
const TILE_SIZE = 256;

export function intensityLabelJa(mmh: number): string {
  if (mmh <= 0) return "なし";
  if (mmh < 1) return "ごく弱い雨";
  if (mmh < 5) return "弱い雨";
  if (mmh < 10) return "やや強い雨";
  if (mmh < 20) return "強い雨";
  if (mmh < 30) return "激しい雨";
  if (mmh < 50) return "非常に激しい雨";
  return "猛烈な雨";
}

/** WGS84 → XYZ タイル座標とタイル内画素 */
export function latLonToTilePixel(
  lat: number,
  lon: number,
  z: number,
  tileSize = TILE_SIZE,
): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const xFloat = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFloat =
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xFloat);
  const y = Math.floor(yFloat);
  const px = Math.min(tileSize - 1, Math.max(0, Math.floor((xFloat - x) * tileSize)));
  const py = Math.min(tileSize - 1, Math.max(0, Math.floor((yFloat - y) * tileSize)));
  return { x, y, px, py };
}

/** JMA hrpns は偶数ズームのみ実データがある */
export function clampEvenZoom(z: number, min: number, max: number): number {
  let v = Math.round(z);
  if (v < min) v = min;
  if (v > max) v = max;
  if (v % 2 !== 0) {
    const down = v - 1;
    const up = v + 1;
    if (down >= min) v = down;
    else if (up <= max) v = up;
    else v = min % 2 === 0 ? min : min + 1;
  }
  return v;
}

function rgbToMmh(r: number, g: number, b: number, a: number): number {
  if (a < 16) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (const c of HRPNS_RGB_MMH) {
    const dr = r - c.r;
    const dg = g - c.g;
    const db = b - c.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = c.mmh;
    }
  }
  // 白〜ほぼ白は無降水扱い
  if (bestDist > 40 * 40) return 0;
  return best;
}

export function sampleIntensityFromDecoded(
  decoded: { width: number; height: number; indices: Uint8Array | null; rgba: Uint8Array },
  px: number,
  py: number,
  radiusPx: number,
): number {
  const { width, height, indices, rgba } = decoded;
  let maxMmh = 0;
  const r = Math.max(0, Math.min(8, Math.floor(radiusPx)));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.min(width - 1, Math.max(0, px + dx));
      const y = Math.min(height - 1, Math.max(0, py + dy));
      const i = y * width + x;
      let mmh = 0;
      if (indices) {
        const idx = indices[i]!;
        mmh = HRPNS_INDEX_MMH[idx] ?? 0;
      } else {
        const o = i * 4;
        mmh = rgbToMmh(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, rgba[o + 3]!);
      }
      if (mmh > maxMmh) maxMmh = mmh;
    }
  }
  return maxMmh;
}

export function pointInCoverage(lat: number, lon: number): boolean {
  const [west, south, east, north] = JAPAN_COVERAGE_BBOX;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function buildMapUrl(webBase: string | undefined, lat: number, lon: number, z: number): string | null {
  if (!webBase || !webBase.trim()) return null;
  const base = webBase.replace(/\/?$/, "/");
  const u = new URL(base);
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("lon", String(lon));
  u.searchParams.set("z", String(z));
  return u.toString();
}

export type EvaluatePrecipInput = {
  lat: number;
  lon: number;
  entries: TargetTimeEntry[];
  fetchedAtMs: number;
  nowMs: number;
  horizonMinutes: number;
  minIntensityMmh: number;
  zoom: number;
  zoomMin: number;
  zoomMax: number;
  radiusPx: number;
  webPublicBase?: string;
  /** 上流タイル取得（テスト差し替え用） */
  fetchTile?: (
    basetime: string,
    validtime: string,
    z: number,
    x: number,
    y: number,
  ) => Promise<Response>;
};

function selectFramesForHorizon(
  entries: TargetTimeEntry[],
  nowMs: number,
  horizonMinutes: number,
): TargetTimeEntry[] {
  const horizonMs = horizonMinutes * 60_000;
  const filtered = entries
    .filter((e) => !e.elements || e.elements.includes("hrpns"))
    .map((e) => ({ e, ms: Date.parse(jmaNowcTimeToUtcIso(e.validtime)) }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => a.ms - b.ms);

  // 直近の解析コマ（now 以前で最新）＋ horizon 内の未来コマ
  let latestPast: (typeof filtered)[number] | null = null;
  const future: typeof filtered = [];
  for (const row of filtered) {
    if (row.ms <= nowMs) latestPast = row;
    else if (row.ms <= nowMs + horizonMs) future.push(row);
  }

  const out: TargetTimeEntry[] = [];
  if (latestPast) out.push(latestPast.e);
  for (const f of future) out.push(f.e);

  // 解析が無く未来だけ、または解析のみ、の場合もそのまま
  if (out.length === 0 && filtered.length > 0) {
    // フォールバック: 末尾近くを数コマ
    return filtered.slice(-8).map((x) => x.e);
  }
  // 上流負荷抑制: 最大 13 コマ（〜1h / 5分）
  if (out.length > 13) {
    const head = out[0]!;
    const rest = out.slice(1);
    const step = Math.ceil(rest.length / 12);
    const sampled = [head];
    for (let i = 0; i < rest.length; i += step) sampled.push(rest[i]!);
    const last = out[out.length - 1]!;
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled;
  }
  return out;
}

export async function evaluatePrecipAtPoint(input: EvaluatePrecipInput): Promise<PrecipAlertV1> {
  const {
    lat,
    lon,
    entries,
    fetchedAtMs,
    nowMs,
    horizonMinutes,
    minIntensityMmh,
    zoomMin,
    zoomMax,
    radiusPx,
    webPublicBase,
  } = input;
  const z = clampEvenZoom(input.zoom, zoomMin, zoomMax);
  const tile = latLonToTilePixel(lat, lon, z);
  const fetchTile = input.fetchTile ?? fetchUpstreamTile;

  const stale = entries.length === 0 || nowMs - fetchedAtMs > STALE_AFTER_MS;
  const frames = selectFramesForHorizon(entries, nowMs, horizonMinutes);
  const forecast_available = entries.some(
    (e) =>
      (!e.elements || e.elements.includes("hrpns")) && frameRoleFromEntry(e) === "forecast",
  );

  const samples: PrecipSample[] = [];
  for (const e of frames) {
    const frame_id = frameIdForEntry(e);
    const time = jmaNowcTimeToUtcIso(e.validtime);
    const role = frameRoleFromEntry(e);
    let intensity_mmh = 0;
    try {
      const res = await fetchTile(e.basetime, e.validtime, z, tile.x, tile.y);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > 0) {
          const decoded = await decodePng(buf);
          intensity_mmh = sampleIntensityFromDecoded(decoded, tile.px, tile.py, radiusPx);
        }
      }
    } catch {
      intensity_mmh = 0;
    }
    const raining = intensity_mmh >= minIntensityMmh;
    samples.push({
      frame_id,
      time,
      role,
      intensity_mmh,
      intensity_label: intensityLabelJa(intensity_mmh),
      raining,
    });
  }

  /** いま時刻以前で最も新しいコマ（実況の近似） */
  let currentSample: PrecipSample | null = null;
  let onset: PrecipSample | null = null;
  let peak: PrecipSample | null = null;
  for (const s of samples) {
    const ms = Date.parse(s.time);
    if (!Number.isNaN(ms) && ms <= nowMs) {
      if (!currentSample || Date.parse(currentSample.time) <= ms) currentSample = s;
    }
    // 降り始め = 現在より後で最初に閾値を超えるコマ
    if (!Number.isNaN(ms) && ms > nowMs && s.raining && !onset) onset = s;
    if (!peak || s.intensity_mmh > peak.intensity_mmh) peak = s;
  }
  if (peak && peak.intensity_mmh <= 0) peak = null;

  const currently_raining = currentSample?.raining === true;
  const raining_soon =
    currently_raining || samples.some((s) => {
      const ms = Date.parse(s.time);
      return !Number.isNaN(ms) && ms > nowMs && s.raining;
    });

  let eta_minutes: number | null = null;
  if (currently_raining) {
    eta_minutes = 0;
  } else if (onset) {
    const ms = Date.parse(onset.time);
    if (!Number.isNaN(ms)) {
      eta_minutes = Math.max(0, Math.round((ms - nowMs) / 60_000));
    }
  }

  const notify_recommended =
    !currently_raining &&
    onset !== null &&
    (eta_minutes ?? 0) <= horizonMinutes;

  return {
    contract_version: "1",
    lat,
    lon,
    zoom: z,
    horizon_minutes: horizonMinutes,
    min_intensity_mmh: minIntensityMmh,
    stale,
    forecast_available,
    currently_raining,
    raining_soon,
    notify_recommended,
    eta_minutes,
    onset,
    peak,
    samples,
    map_url: buildMapUrl(webPublicBase, lat, lon, Math.min(10, Math.max(6, z))),
    tile_xy: { z, x: tile.x, y: tile.y, px: tile.px, py: tile.py },
    provider_attribution:
      "出典：気象庁（防災気象情報・ナウキャスト等）。利用条件は公式サイトを確認してください。",
  };
}

export function fakePrecipAlert(input: {
  lat: number;
  lon: number;
  zoom: number;
  horizonMinutes: number;
  minIntensityMmh: number;
  webPublicBase?: string;
}): PrecipAlertV1 {
  const z = clampEvenZoom(input.zoom, 4, 10);
  const tile = latLonToTilePixel(input.lat, input.lon, z);
  const onset: PrecipSample = {
    frame_id: "fake_forecast",
    time: "2020-01-01T01:00:00.000Z",
    role: "forecast",
    intensity_mmh: 3,
    intensity_label: intensityLabelJa(3),
    raining: true,
  };
  return {
    contract_version: "1",
    lat: input.lat,
    lon: input.lon,
    zoom: z,
    horizon_minutes: input.horizonMinutes,
    min_intensity_mmh: input.minIntensityMmh,
    stale: true,
    forecast_available: true,
    currently_raining: false,
    raining_soon: true,
    notify_recommended: true,
    eta_minutes: 15,
    onset,
    peak: onset,
    samples: [
      {
        frame_id: "fake_analysis",
        time: "2020-01-01T00:00:00.000Z",
        role: "analysis",
        intensity_mmh: 0,
        intensity_label: "なし",
        raining: false,
      },
      onset,
    ],
    map_url: buildMapUrl(input.webPublicBase, input.lat, input.lon, z),
    tile_xy: { z, x: tile.x, y: tile.y, px: tile.px, py: tile.py },
    provider_attribution: "FAKE PROVIDER（開発・テスト用）",
  };
}
