import { JAPAN_COVERAGE_BBOX } from "./domain";

const GSI_ADDRESS_SEARCH_URL =
  "https://msearch.gsi.go.jp/address-search/AddressSearch";
const MAX_QUERY_LENGTH = 120;
const MAX_RESULTS = 8;
const FETCH_TIMEOUT_MS = 8_000;

export type GeocodeResult = {
  label: string;
  lat: number;
  lon: number;
};

export type GeocodeSearchResponse = {
  query: string;
  results: GeocodeResult[];
  provider_attribution: string;
};

type GsiFeature = {
  type: "Feature";
  geometry?: {
    type: "Point";
    coordinates?: [number, number];
  };
  properties?: {
    title?: string;
  };
};

export const GSI_GEOCODE_ATTRIBUTION =
  "住所検索: 国土地理院（地理院地図。https://maps.gsi.go.jp/ ）";

function pointInJapanCoverage(lon: number, lat: number): boolean {
  const [w, s, e, n] = JAPAN_COVERAGE_BBOX;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

export function normalizeGeocodeQuery(raw: string): string | null {
  const query = raw.trim().replace(/\s+/g, " ");
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    return null;
  }
  return query;
}

function parseGsiFeatures(body: unknown): GeocodeResult[] {
  if (!Array.isArray(body)) {
    return [];
  }

  const results: GeocodeResult[] = [];
  for (const row of body as GsiFeature[]) {
    if (row.type !== "Feature") continue;
    const coords = row.geometry?.coordinates;
    const label = row.properties?.title?.trim();
    if (!coords || coords.length < 2 || !label) continue;

    const lon = coords[0]!;
    const lat = coords[1]!;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!pointInJapanCoverage(lon, lat)) continue;

    results.push({ label, lat, lon });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

export async function searchJapaneseAddress(query: string): Promise<GeocodeSearchResponse> {
  const url = `${GSI_ADDRESS_SEARCH_URL}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "rainmap-worker/0.1",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`gsi_geocode_http_${res.status}`);
  }

  const body: unknown = await res.json();
  return {
    query,
    results: parseGsiFeatures(body),
    provider_attribution: GSI_GEOCODE_ATTRIBUTION,
  };
}
