import {
  JAPAN_COVERAGE_BBOX,
  defaultFrameIndexForInitialView,
  frameIdForEntry,
  frameRoleFromEntry,
  jmaNowcTimeToUtcIso,
  type TargetTimeEntry,
} from "./domain";
import type { RadarMetaV1 } from "./types";

const STALE_AFTER_MS = 15 * 60 * 1000;

export function buildRadarMetaV1(input: {
  apiOrigin: string;
  entries: TargetTimeEntry[];
  fetchedAtMs: number;
  zoomMin: number;
  zoomMax: number;
}): RadarMetaV1 {
  const { apiOrigin, entries, fetchedAtMs, zoomMin, zoomMax } = input;
  const now = Date.now();
  const stale = entries.length === 0 || now - fetchedAtMs > STALE_AFTER_MS;

  const framesAsc = [...entries]
    .filter((e) => !e.elements || e.elements.includes("hrpns"))
    .map((e) => {
      const time = jmaNowcTimeToUtcIso(e.validtime);
      const role = frameRoleFromEntry(e);
      return {
        id: frameIdForEntry(e),
        time,
        zoom_range: { min: zoomMin, max: zoomMax },
        role,
      };
    })
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  /** 観測・解析寄り（analysis）のうち最も新しい valid。メタの latest_* と一致させる。 */
  let latestAnalysis: string | null = null;
  for (const f of framesAsc) {
    if (f.role === "analysis") {
      if (!latestAnalysis || f.time > latestAnalysis) latestAnalysis = f.time;
    }
  }

  const latest_available_time = latestAnalysis;
  const latest_analysis_time = latestAnalysis;

  const forecast_available = framesAsc.some((f) => f.role === "forecast");

  const defaultIdx = defaultFrameIndexForInitialView(framesAsc, now);
  const default_frame_id =
    framesAsc.length === 0 ? null : framesAsc[defaultIdx]!.id;

  const tile_url_template = `${apiOrigin}/tiles/nowc/{frame_id}/{z}/{x}/{y}.png`;

  return {
    contract_version: "1",
    crs: "EPSG:3857",
    tile_url_template,
    latest_available_time,
    latest_analysis_time,
    forecast_available,
    default_frame_id,
    stale,
    coverage: {
      bbox: JAPAN_COVERAGE_BBOX,
      tile_matrix: "XYZ",
    },
    frames: framesAsc,
    time_estimated: false,
    provider_attribution:
      "出典：気象庁（防災気象情報・ナウキャスト等）。利用条件は公式サイトを確認してください。",
  };
}

export function fakeMeta(apiOrigin: string): RadarMetaV1 {
  const tAnalysis = "2020-01-01T00:00:00Z";
  const tForecast = "2020-01-01T01:00:00Z";
  return {
    contract_version: "1",
    crs: "EPSG:3857",
    tile_url_template: `${apiOrigin}/tiles/nowc/{frame_id}/{z}/{x}/{y}.png`,
    latest_available_time: tAnalysis,
    latest_analysis_time: tAnalysis,
    forecast_available: true,
    stale: true,
    coverage: {
      bbox: JAPAN_COVERAGE_BBOX,
      tile_matrix: "XYZ",
    },
    frames: [
      {
        id: "fake_analysis",
        time: tAnalysis,
        zoom_range: { min: 4, max: 10 },
        role: "analysis",
      },
      {
        id: "fake_forecast",
        time: tForecast,
        zoom_range: { min: 4, max: 10 },
        role: "forecast",
      },
    ],
    default_frame_id: "fake_analysis",
    time_estimated: true,
    provider_attribution: "FAKE PROVIDER（開発・テスト用）",
  };
}
