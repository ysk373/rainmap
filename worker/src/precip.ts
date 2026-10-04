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
import { fetchUpstreamTile, upstreamTileUrl } from "./provider";

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

/** コマ単位の取得・デコード失敗の種類（失敗を 0 mm/h として扱わない） */
export type FrameErrorKind = "http_error" | "timeout" | "fetch_error" | "decode_error";

export type PrecipSample = {
  frame_id: string;
  time: string;
  role: FrameRole;
  /** タイルを取得・デコードできたとき true */
  ok: boolean;
  error: FrameErrorKind | null;
  /** error が "http_error" のときだけ上流の HTTP ステータス（404 も失敗） */
  http_status: number | null;
  /** ok=false のときは null（0 ではない） */
  intensity_mmh: number | null;
  intensity_label: string | null;
  raining: boolean | null;
};

/** 評価に成功したコマ（強度が数値で入っている） */
type OkSample = PrecipSample & { ok: true; intensity_mmh: number; raining: boolean };

export type FailedFrame = {
  frame_id: string;
  time: string;
  role: FrameRole;
  error: FrameErrorKind;
  http_status: number | null;
};

export type PrecipUpstreamErrorReason =
  | "all_frames_failed"
  | "current_frame_failed"
  | "no_current_frame";

export type PrecipUpstreamErrorBody = {
  error_code: "upstream_error";
  reason: PrecipUpstreamErrorReason;
  message: string;
  complete: false;
  failed_frames: FailedFrame[];
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
  /**
   * まもなく降り始める（いまは降っていない）とき true。n8n の通知条件に使いやすい。
   * complete=false（どれかのコマが失敗）のときは常に false。
   */
  notify_recommended: boolean;
  eta_minutes: number | null;
  onset: PrecipSample | null;
  peak: PrecipSample | null;
  samples: PrecipSample[];
  /** 評価したすべてのコマを取得・デコードできたとき true */
  complete: boolean;
  /** 失敗したコマ（complete=true なら空配列） */
  failed_frames: FailedFrame[];
  map_url: string | null;
  tile_xy: { z: number; x: number; y: number; px: number; py: number };
  provider_attribution: string;
};

const STALE_AFTER_MS = 15 * 60 * 1000;
const TILE_SIZE = 256;
/** タイル 1 枚の上限（provider の FETCH_TIMEOUT_MS と同じ） */
const TILE_FETCH_TIMEOUT_MS = 10_000;
/** 全タイル取得の時間の上限（超えたコマは timeout の失敗） */
export const PRECIP_TILE_BUDGET_MS = 8_000;
/** タイル取得の同時数の上限 */
export const PRECIP_TILE_CONCURRENCY = 4;

/** 成功した応答だけの Cache-Control（部分失敗・エラーは no-store） */
export const PRECIP_OK_CACHE_CONTROL = "max-age=60, stale-while-revalidate=120";

const UPSTREAM_ERROR_MESSAGES: Record<PrecipUpstreamErrorReason, string> = {
  all_frames_failed: "気象庁タイルの取得に失敗しました（全コマ）。しばらくして再試行してください。",
  current_frame_failed:
    "現在のコマの気象庁タイルを取得できませんでした。しばらくして再試行してください。",
  no_current_frame: "現在時刻のコマが見つからないため判定できません。",
};

/**
 * 上流タイルのキャッシュ（Worker では caches.default、テストでは省略）。
 * 取得・デコードに成功したタイルだけを put する。
 */
export type TileCache = {
  match(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
};

export type FetchTileFn = (
  basetime: string,
  validtime: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
) => Promise<Response>;

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
  /** 上流タイル取得（テスト差し替え用）。signal は時間の上限で abort される */
  fetchTile?: FetchTileFn;
  /** 上流タイルのキャッシュ（省略時はキャッシュしない） */
  tileCache?: TileCache;
  /** 全タイル取得の時間の上限（ms、既定 PRECIP_TILE_BUDGET_MS） */
  budgetMs?: number;
  /** 同時取得数（既定 PRECIP_TILE_CONCURRENCY） */
  concurrency?: number;
};

export type PrecipEvaluation =
  | { ok: true; alert: PrecipAlertV1 }
  | { ok: false; error: PrecipUpstreamErrorBody };

/** 評価結果 → HTTP ステータス・Cache-Control・本文（design/11 の契約） */
export function precipHttpResult(evaluation: PrecipEvaluation): {
  status: number;
  cacheControl: string;
  body: PrecipAlertV1 | PrecipUpstreamErrorBody;
} {
  if (!evaluation.ok) {
    return { status: 502, cacheControl: "no-store", body: evaluation.error };
  }
  return {
    status: 200,
    cacheControl: evaluation.alert.complete ? PRECIP_OK_CACHE_CONTROL : "no-store",
    body: evaluation.alert,
  };
}

type FrameOutcome =
  | { ok: true; intensity_mmh: number }
  | { ok: false; error: FrameErrorKind; http_status: number | null };

class FrameFailure extends Error {
  constructor(
    readonly kind: FrameErrorKind,
    readonly httpStatus: number | null = null,
  ) {
    super(kind);
  }
}

function isAbortLike(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

async function evaluateFrame(
  e: TargetTimeEntry,
  z: number,
  tile: { x: number; y: number; px: number; py: number },
  radiusPx: number,
  fetchTile: FetchTileFn,
  tileCache: TileCache | undefined,
  deadlineMs: number,
): Promise<FrameOutcome> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return { ok: false, error: "timeout", http_status: null };
  const timeoutMs = Math.min(TILE_FETCH_TIMEOUT_MS, remaining);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FrameFailure("timeout"));
    }, timeoutMs);
  });

  const work = async (): Promise<{ mmh: number; bytes: Uint8Array; fromCache: boolean }> => {
    const key = upstreamTileUrl(e.basetime, e.validtime, z, tile.x, tile.y);
    let bytes: Uint8Array | null = null;
    let fromCache = false;
    if (tileCache) {
      try {
        bytes = await tileCache.match(key);
        fromCache = bytes !== null && bytes.byteLength > 0;
      } catch {
        bytes = null;
      }
    }
    if (!fromCache) {
      let res: Response;
      try {
        res = await fetchTile(e.basetime, e.validtime, z, tile.x, tile.y, controller.signal);
      } catch (err) {
        throw new FrameFailure(isAbortLike(err) ? "timeout" : "fetch_error");
      }
      if (!res.ok) throw new FrameFailure("http_error", res.status);
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw new FrameFailure(isAbortLike(err) ? "timeout" : "fetch_error");
      }
      if (bytes.byteLength === 0) throw new FrameFailure("fetch_error");
    }
    let mmh: number;
    try {
      const decoded = await decodePng(bytes!);
      // 気象庁のタイルは 256x256。ほかの大きさ（プレースホルダ等）は雨なしと区別できないので失敗にする
      if (decoded.width !== TILE_SIZE || decoded.height !== TILE_SIZE) {
        throw new Error("unexpected_tile_size");
      }
      mmh = sampleIntensityFromDecoded(decoded, tile.px, tile.py, radiusPx);
    } catch {
      throw new FrameFailure("decode_error");
    }
    return { mmh, bytes: bytes!, fromCache };
  };

  let done: { mmh: number; bytes: Uint8Array; fromCache: boolean };
  try {
    done = await Promise.race([work(), timeout]);
  } catch (err) {
    if (err instanceof FrameFailure) {
      return { ok: false, error: err.kind, http_status: err.httpStatus };
    }
    return { ok: false, error: "fetch_error", http_status: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // 取得・デコードに成功したタイルだけをキャッシュする（時間の上限の外で行う）
  if (tileCache && !done.fromCache) {
    try {
      await tileCache.put(upstreamTileUrl(e.basetime, e.validtime, z, tile.x, tile.y), done.bytes);
    } catch {
      // キャッシュの失敗は評価に影響させない
    }
  }
  return { ok: true, intensity_mmh: done.mmh };
}

/** 同時数に上限をつけて並列に評価する（結果は入力と同じ順） */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

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

export async function evaluatePrecipAtPoint(input: EvaluatePrecipInput): Promise<PrecipEvaluation> {
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
  const deadlineMs = Date.now() + (input.budgetMs ?? PRECIP_TILE_BUDGET_MS);

  const stale = entries.length === 0 || nowMs - fetchedAtMs > STALE_AFTER_MS;
  const frames = selectFramesForHorizon(entries, nowMs, horizonMinutes);
  const forecast_available = entries.some(
    (e) =>
      (!e.elements || e.elements.includes("hrpns")) && frameRoleFromEntry(e) === "forecast",
  );

  const outcomes = await mapWithConcurrency(
    frames,
    input.concurrency ?? PRECIP_TILE_CONCURRENCY,
    (e) => evaluateFrame(e, z, tile, radiusPx, fetchTile, input.tileCache, deadlineMs),
  );

  const samples: PrecipSample[] = frames.map((e, i) => {
    const base = {
      frame_id: frameIdForEntry(e),
      time: jmaNowcTimeToUtcIso(e.validtime),
      role: frameRoleFromEntry(e),
    };
    const o = outcomes[i]!;
    if (o.ok) {
      return {
        ...base,
        ok: true,
        error: null,
        http_status: null,
        intensity_mmh: o.intensity_mmh,
        intensity_label: intensityLabelJa(o.intensity_mmh),
        raining: o.intensity_mmh >= minIntensityMmh,
      };
    }
    return {
      ...base,
      ok: false,
      error: o.error,
      http_status: o.http_status,
      intensity_mmh: null,
      intensity_label: null,
      raining: null,
    };
  });

  const failed_frames: FailedFrame[] = samples
    .filter((s) => !s.ok)
    .map((s) => ({
      frame_id: s.frame_id,
      time: s.time,
      role: s.role,
      error: s.error!,
      http_status: s.http_status,
    }));
  const complete = failed_frames.length === 0;

  /** いま時刻以前で最も新しいコマ（実況の近似）。成功・失敗を問わず選ぶ */
  let currentSample: PrecipSample | null = null;
  for (const s of samples) {
    const ms = Date.parse(s.time);
    if (!Number.isNaN(ms) && ms <= nowMs) {
      if (!currentSample || Date.parse(currentSample.time) <= ms) currentSample = s;
    }
  }

  const upstreamError = (reason: PrecipUpstreamErrorReason): PrecipEvaluation => ({
    ok: false,
    error: {
      error_code: "upstream_error",
      reason,
      message: UPSTREAM_ERROR_MESSAGES[reason],
      complete: false,
      failed_frames,
    },
  });
  // 理由の優先順位: コマ無し → 全コマ失敗 → 現在コマ無し → 現在コマ失敗
  if (samples.length === 0) return upstreamError("no_current_frame");
  if (samples.every((s) => !s.ok)) return upstreamError("all_frames_failed");
  if (!currentSample) return upstreamError("no_current_frame");
  if (!currentSample.ok) return upstreamError("current_frame_failed");

  // 以降は成功したコマだけで判定する（complete=false なら当てにならない）
  const okSamples = samples.filter((s): s is OkSample => s.ok);
  let onset: PrecipSample | null = null;
  let peak: OkSample | null = null;
  for (const s of okSamples) {
    const ms = Date.parse(s.time);
    // 降り始め = 現在より後で最初に閾値を超えるコマ
    if (!Number.isNaN(ms) && ms > nowMs && s.raining && !onset) onset = s;
    if (!peak || s.intensity_mmh > peak.intensity_mmh) peak = s;
  }
  if (peak && peak.intensity_mmh <= 0) peak = null;

  const currently_raining = currentSample.raining === true;
  const raining_soon =
    currently_raining ||
    okSamples.some((s) => {
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
    complete &&
    !currently_raining &&
    onset !== null &&
    (eta_minutes ?? 0) <= horizonMinutes;

  return {
    ok: true,
    alert: {
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
      complete,
      failed_frames,
      map_url: buildMapUrl(webPublicBase, lat, lon, Math.min(10, Math.max(6, z))),
      tile_xy: { z, x: tile.x, y: tile.y, px: tile.px, py: tile.py },
      provider_attribution:
        "出典：気象庁（防災気象情報・ナウキャスト等）。利用条件は公式サイトを確認してください。",
    },
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
    ok: true,
    error: null,
    http_status: null,
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
        ok: true,
        error: null,
        http_status: null,
        intensity_mmh: 0,
        intensity_label: "なし",
        raining: false,
      },
      onset,
    ],
    complete: true,
    failed_frames: [],
    map_url: buildMapUrl(input.webPublicBase, input.lat, input.lon, z),
    tile_xy: { z, x: tile.x, y: tile.y, px: tile.px, py: tile.py },
    provider_attribution: "FAKE PROVIDER（開発・テスト用）",
  };
}
