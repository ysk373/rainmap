export type RadarMetaV1 = {
  contract_version: "1";
  crs: "EPSG:3857";
  tile_url_template: string;
  latest_available_time: string | null;
  stale: boolean;
  coverage: {
    bbox: [number, number, number, number];
    tile_matrix: "XYZ";
  };
  frames: Array<{
    id: string;
    time: string;
    zoom_range: { min: number; max: number };
    /** 省略時は旧クライアント互換（不明） */
    role?: "analysis" | "forecast";
  }>;
  /** メタに短期予報コマ（forecast）が含まれるか */
  forecast_available?: boolean;
  /** 観測・解析寄りコマのうち最も新しい valid（UTC ISO）。`latest_available_time` と同値を推奨 */
  latest_analysis_time?: string | null;
  /** 主用途（直近の降水見通し）向けに推奨するフレーム。無い場合はクライアントが従来どおり latest を使う。 */
  default_frame_id: string | null;
  time_estimated?: boolean;
  provider_attribution?: string;
};

export type Env = {
  RADAR_KV: KVNamespace;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  FAKE_PROVIDER: string;
  API_PUBLIC_ORIGIN?: string;
  ZOOM_MIN?: string;
  ZOOM_MAX?: string;
};
