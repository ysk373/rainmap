import type { TargetTimeEntry } from "./domain";
import { parseTargetTimesJson } from "./domain";

const JMA_TARGET_TIMES =
  "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TARGET_TIMES_BYTES = 512_000;

export async function fetchJmaTargetTimesBody(): Promise<string> {
  const res = await fetch(JMA_TARGET_TIMES, {
    headers: { Accept: "application/json", "User-Agent": "rainmap-worker/0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`jma_target_times_http_${res.status}`);
  }
  const text = await res.text();
  if (new TextEncoder().encode(text).byteLength > MAX_TARGET_TIMES_BYTES) {
    throw new Error("jma_target_times_too_large");
  }
  return text;
}

export function parseTargetTimesBody(body: string): TargetTimeEntry[] {
  return parseTargetTimesJson(body, MAX_TARGET_TIMES_BYTES);
}

export function upstreamTileUrl(
  basetime: string,
  validtime: string,
  z: number,
  x: number,
  y: number,
): string {
  return `https://www.jma.go.jp/bosai/jmatile/data/nowc/${basetime}/none/${validtime}/surf/hrpns/${z}/${x}/${y}.png`;
}

export async function fetchUpstreamTile(
  basetime: string,
  validtime: string,
  z: number,
  x: number,
  y: number,
): Promise<Response> {
  const url = upstreamTileUrl(basetime, validtime, z, x, y);
  return fetch(url, {
    headers: { "User-Agent": "rainmap-worker/0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}
