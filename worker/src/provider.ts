import type { TargetTimeEntry } from "./domain";
import { parseTargetTimesJson } from "./domain";

const JMA_TARGET_TIMES_N1 =
  "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json";
const JMA_TARGET_TIMES_N2 =
  "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TARGET_TIMES_BYTES = 512_000;

async function fetchTargetTimesJson(url: string): Promise<string> {
  const res = await fetch(url, {
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

/** 降水ナウキャスト・実況／解析に近い時刻一覧（N1） */
export async function fetchJmaTargetTimesN1Body(): Promise<string> {
  return fetchTargetTimesJson(JMA_TARGET_TIMES_N1);
}

/** 降水ナウキャスト・短期予報コマ一覧（N2、約1時間先まで） */
export async function fetchJmaTargetTimesN2Body(): Promise<string> {
  return fetchTargetTimesJson(JMA_TARGET_TIMES_N2);
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
