import {
  JAPAN_COVERAGE_BBOX,
  defaultFrameIndexForUpcoming,
  frameIdForEntry,
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
      return {
        id: frameIdForEntry(e),
        time,
        zoom_range: { min: zoomMin, max: zoomMax },
      };
    })
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const latest =
    framesAsc.length === 0 ? null : framesAsc[framesAsc.length - 1]!.time;

  const upcomingIdx = defaultFrameIndexForUpcoming(
    framesAsc.map((f) => f.time),
    now,
  );
  const default_frame_id =
    framesAsc.length === 0 ? null : framesAsc[upcomingIdx]!.id;

  const tile_url_template = `${apiOrigin}/tiles/nowc/{frame_id}/{z}/{x}/{y}.png`;

  return {
    contract_version: "1",
    crs: "EPSG:3857",
    tile_url_template,
    latest_available_time: latest,
    default_frame_id,
    stale,
    coverage: {
      bbox: JAPAN_COVERAGE_BBOX,
      tile_matrix: "XYZ",
    },
    frames: framesAsc,
    time_estimated: false,
    provider_attribution: "出典：気象庁（防災気象情報・ナウキャスト等）。利用条件は公式サイトを確認してください。",
  };
}

export function fakeMeta(apiOrigin: string): RadarMetaV1 {
  const t = "2020-01-01T00:00:00Z";
  return {
    contract_version: "1",
    crs: "EPSG:3857",
    tile_url_template: `${apiOrigin}/tiles/nowc/{frame_id}/{z}/{x}/{y}.png`,
    latest_available_time: t,
    stale: true,
    coverage: {
      bbox: JAPAN_COVERAGE_BBOX,
      tile_matrix: "XYZ",
    },
    frames: [
      {
        id: "fake_frame",
        time: t,
        zoom_range: { min: 4, max: 10 },
      },
    ],
    default_frame_id: "fake_frame",
    time_estimated: true,
    provider_attribution: "FAKE PROVIDER（開発・テスト用）",
  };
}
