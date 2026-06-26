import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

type RadarMeta = {
  contract_version: string;
  crs: string;
  tile_url_template: string;
  latest_available_time: string | null;
  latest_analysis_time?: string | null;
  forecast_available?: boolean;
  default_frame_id?: string | null;
  stale: boolean;
  coverage: { bbox: [number, number, number, number]; tile_matrix: string };
  frames: Array<{
    id: string;
    time: string;
    zoom_range: { min: number; max: number };
    role?: "analysis" | "forecast";
  }>;
  provider_attribution?: string;
};

const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
if (!apiBase) {
  throw new Error("VITE_API_BASE_URL が未設定です。.env.example を参照してください。");
}

const metaRefreshMs = 120_000;
const DEFAULT_LAT = 35.4437;
const DEFAULT_LON = 139.638;
const DEFAULT_ZOOM = 10;
const MAP_MIN_ZOOM = 1;
const MAP_MAX_ZOOM = 18;

function clampZoom(z: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, z));
}

function parseQuery(mapZoomRange: { min: number; max: number }): {
  lat: number;
  lon: number;
  z: number;
} {
  const p = new URLSearchParams(window.location.search);
  const lat = Number.parseFloat(p.get("lat") || String(DEFAULT_LAT));
  const lon = Number.parseFloat(p.get("lon") ?? p.get("lng") ?? String(DEFAULT_LON));
  const z = Number.parseInt(p.get("z") || String(DEFAULT_ZOOM), 10);
  const fallbackZ = clampZoom(DEFAULT_ZOOM, mapZoomRange.min, mapZoomRange.max);
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_LAT,
    lon: Number.isFinite(lon) ? lon : DEFAULT_LON,
    z: Number.isFinite(z) ? clampZoom(z, mapZoomRange.min, mapZoomRange.max) : fallbackZ,
  };
}

async function fetchMeta(): Promise<RadarMeta> {
  const res = await fetch(`${apiBase}/api/v1/radar/meta`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`メタデータ取得失敗 (${res.status}): ${text}`);
  }
  return (await res.json()) as RadarMeta;
}

function leafletTemplateFromMetaTemplate(
  template: string,
  frameId: string,
): string {
  return template
    .replace("{frame_id}", encodeURIComponent(frameId))
    .replace("{z}", "{z}")
    .replace("{x}", "{x}")
    .replace("{y}", "{y}");
}

/** 気象庁ナウキャストのコマ時刻は常に日本標準時で表示（端末のタイムゾーンに依存しない） */
function formatFrameTimeJst(isoUtc: string): string {
  try {
    const d = new Date(isoUtc);
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "Asia/Tokyo",
    }).format(d);
  } catch {
    return isoUtc;
  }
}

function radarLayerOptions(radarZoomRange: { min: number; max: number }): L.TileLayerOptions {
  return {
    opacity: 0.75,
    detectRetina: false,
    minNativeZoom: radarZoomRange.min,
    minZoom: MAP_MIN_ZOOM,
    maxNativeZoom: radarZoomRange.max,
    maxZoom: MAP_MAX_ZOOM,
  };
}

type GridLayerInternal = L.GridLayer & {
  _clampZoom(zoom: number): number;
};

type TileLayerConstructor = new (
  url: string,
  options?: L.TileLayerOptions,
) => L.TileLayer;

/**
 * JMA ナウキャスト hrpns は偶数 z のみタイルが存在する (4,6,8,10)。
 * 奇数 z では上流が 404 を返すため、取得ズームを偶数へ寄せる。
 */
const RadarTileLayer = L.TileLayer.extend({
  _clampZoom(this: L.TileLayer, zoom: number): number {
    const base = L.GridLayer.prototype as GridLayerInternal;
    let z = base._clampZoom.call(this, zoom);
    if (z % 2 !== 0) {
      const floor = z - 1;
      const ceil = z + 1;
      const { minNativeZoom, maxNativeZoom } = this.options;
      if (minNativeZoom !== undefined && floor >= minNativeZoom) {
        z = floor;
      } else if (maxNativeZoom !== undefined && ceil <= maxNativeZoom) {
        z = ceil;
      }
    }
    return z;
  },
}) as TileLayerConstructor;

function main(): void {
  const statusEl = document.getElementById("status")!;
  const attrEl = document.getElementById("attr")!;
  const frameLabel = document.getElementById("frame-label")!;
  const btnPrev = document.getElementById("btn-prev") as HTMLButtonElement;
  const btnNext = document.getElementById("btn-next") as HTMLButtonElement;
  const btnPlay = document.getElementById("btn-play") as HTMLButtonElement;

  const mapZoomRange = { min: MAP_MIN_ZOOM, max: MAP_MAX_ZOOM };
  const q = parseQuery(mapZoomRange);
  const map = L.map("map", {
    minZoom: mapZoomRange.min,
    maxZoom: mapZoomRange.max,
  }).setView([q.lat, q.lon], q.z);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let radarLayer: L.TileLayer | null = null;
  let metaTemplate = "";
  let frames: RadarMeta["frames"] = [];
  let frameIndex = 0;
  let playTimer: number | null = null;
  let metaPollTimer: number | null = null;
  const maxFrames = 56;
  const playMs = 900;

  function stopPlay(): void {
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
    }
    btnPlay.textContent = "再生";
    btnPlay.setAttribute("aria-pressed", "false");
  }

  function syncZoomConstraints(radarZoomRange: { min: number; max: number }): void {
    map.setMinZoom(MAP_MIN_ZOOM);
    map.setMaxZoom(MAP_MAX_ZOOM);
    if (radarLayer) {
      Object.assign(radarLayer.options, radarLayerOptions(radarZoomRange));
      radarLayer.redraw();
    }
  }

  function applyFrame(i: number): void {
    if (frames.length === 0 || !metaTemplate) return;
    frameIndex = ((i % frames.length) + frames.length) % frames.length;
    const frame = frames[frameIndex]!;
    const urlTemplate = leafletTemplateFromMetaTemplate(metaTemplate, frame.id);
    const radarZoomRange = frame.zoom_range;

    if (!radarLayer) {
      radarLayer = new RadarTileLayer(urlTemplate, radarLayerOptions(radarZoomRange));
      radarLayer.addTo(map);
    } else {
      radarLayer.setUrl(urlTemplate);
      radarLayer.setOpacity(0.75);
      Object.assign(radarLayer.options, radarLayerOptions(radarZoomRange));
      radarLayer.redraw();
    }

    const role = frame.role;
    const tag =
      role === "forecast" ? "予報" : role === "analysis" ? "観測" : "";
    frameLabel.textContent = `${frameIndex + 1}/${frames.length} · ${tag ? `${tag} · ` : ""}${formatFrameTimeJst(frame.time)}`;
  }

  function togglePlay(): void {
    if (frames.length === 0) return;
    if (playTimer) {
      stopPlay();
      return;
    }
    btnPlay.textContent = "停止";
    btnPlay.setAttribute("aria-pressed", "true");
    playTimer = window.setInterval(() => {
      applyFrame(frameIndex + 1);
    }, playMs);
  }

  btnPrev.addEventListener("click", () => {
    stopPlay();
    applyFrame(frameIndex - 1);
  });
  btnNext.addEventListener("click", () => {
    stopPlay();
    applyFrame(frameIndex + 1);
  });
  btnPlay.addEventListener("click", () => togglePlay());

  btnPrev.disabled = true;
  btnNext.disabled = true;
  btnPlay.disabled = true;

  function applyMeta(meta: RadarMeta, initial: boolean): void {
    const previousId = frames[frameIndex]?.id;
    metaTemplate = meta.tile_url_template;
    const [w, s, e, n] = meta.coverage.bbox;
    map.setMaxBounds([
      [s, w],
      [n, e],
    ]);

    frames = meta.frames.slice(-maxFrames);
    if (frames.length > 0) {
      syncZoomConstraints(frames[0]!.zoom_range);
    }
    if (frames.length === 0) {
      statusEl.textContent = "利用可能なフレームがありません。";
      btnPrev.disabled = true;
      btnNext.disabled = true;
      btnPlay.disabled = true;
      return;
    }

    if (initial) {
      let idx = frames.length - 1;
      if (meta.default_frame_id) {
        const rec = frames.findIndex((f) => f.id === meta.default_frame_id);
        if (rec >= 0) idx = rec;
      } else if (meta.latest_available_time) {
        const hit = frames.findIndex((f) => f.time === meta.latest_available_time);
        if (hit >= 0) idx = hit;
      }
      frameIndex = idx;
    } else if (previousId) {
      const hit = frames.findIndex((f) => f.id === previousId);
      frameIndex = hit >= 0 ? hit : frames.length - 1;
    } else {
      frameIndex = Math.min(frameIndex, frames.length - 1);
    }

    let statusText = meta.stale
      ? "データが古い可能性があります（stale）。"
      : "接続済み";
    if (!meta.stale && meta.forecast_available === false) {
      statusText += " 短期予報コマはありません。";
    }
    statusEl.textContent = statusText;
    statusEl.classList.toggle("stale", meta.stale);

    attrEl.textContent = [
      meta.provider_attribution,
      "ベース地図: OpenStreetMap（https://www.openstreetmap.org/copyright を参照）。",
    ]
      .filter(Boolean)
      .join(" ");

    applyFrame(frameIndex);
    btnPrev.disabled = false;
    btnNext.disabled = false;
    btnPlay.disabled = false;
  }

  function scheduleMetaPolling(): void {
    if (metaPollTimer !== null) {
      window.clearInterval(metaPollTimer);
    }
    metaPollTimer = window.setInterval(() => {
      void loadMeta(false);
    }, metaRefreshMs);
  }

  async function loadMeta(initial: boolean): Promise<void> {
    try {
      const meta = await fetchMeta();
      applyMeta(meta, initial);
      if (initial) {
        scheduleMetaPolling();
      }
    } catch (err: unknown) {
      if (initial) {
        statusEl.textContent = `エラー: ${String(err)}`;
      } else {
        statusEl.textContent = `メタデータ更新に失敗（前回の表示を継続）: ${String(err)}`;
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void loadMeta(false);
    }
  });

  void loadMeta(true);
}

main();
