import { buildRadarMetaV1, fakeMeta } from "./catalog";
import type { Env } from "./types";
import {
  fetchJmaTargetTimesBody,
  fetchUpstreamTile,
  parseTargetTimesBody,
} from "./provider";
import { JAPAN_COVERAGE_BBOX, tileIntersectsCoverageBbox, type TargetTimeEntry } from "./domain";

const KV_SNAPSHOT = "radar:nowc:snapshot_v1";
/** 後方互換: 旧 2 キー構成からの移行用 */
const KV_LEGACY_BODY = "radar:nowc:target_times_body";
const KV_LEGACY_AT = "radar:nowc:fetched_at_ms";

const TRANSPARENT_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) =>
  c.charCodeAt(0),
);

function isFakeEnabled(env: Env): boolean {
  const v = (env.FAKE_PROVIDER || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function productionFakeViolation(env: Env): boolean {
  return (env.ENVIRONMENT || "").toLowerCase() === "production" && isFakeEnabled(env);
}

function isProduction(env: Env): boolean {
  return (env.ENVIRONMENT || "").toLowerCase() === "production";
}

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => o.replace(/\/$/, ""));
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS || "");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowed.includes(origin.replace(/\/$/, ""))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResponse(
  request: Request,
  env: Env,
  body: unknown,
  init: ResponseInit & { cacheControl?: string; extraHeaders?: Record<string, string> } = {},
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(request, env),
    ...(init.extraHeaders || {}),
  });
  if (init.cacheControl) {
    headers.set("Cache-Control", init.cacheControl);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorJson(
  request: Request,
  env: Env,
  status: number,
  error_code: string,
  message: string,
  opts?: { cacheControl?: string; extraHeaders?: Record<string, string> },
): Response {
  return jsonResponse(request, env, { error_code, message }, { status, ...opts });
}

function apiOrigin(request: Request, env: Env): string {
  if (env.API_PUBLIC_ORIGIN && env.API_PUBLIC_ORIGIN.trim()) {
    return env.API_PUBLIC_ORIGIN.replace(/\/$/, "");
  }
  const o = new URL(request.url).origin;
  if (isProduction(env) && o.startsWith("http://")) {
    throw new Error(
      "本番では API_PUBLIC_ORIGIN に HTTPS の公開 API オリジンを設定してください。",
    );
  }
  return o;
}

function zoomBounds(env: Env): { min: number; max: number } {
  const min = Number.parseInt(env.ZOOM_MIN || "4", 10);
  const max = Number.parseInt(env.ZOOM_MAX || "10", 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return { min: 4, max: 10 };
  }
  return { min, max };
}

async function writeSnapshot(env: Env, body: string, fetchedAtMs: number): Promise<void> {
  const payload = JSON.stringify({ v: 1, body, fetchedAtMs });
  await env.RADAR_KV.put(KV_SNAPSHOT, payload);
}

async function readSnapshot(env: Env): Promise<{
  entries: TargetTimeEntry[];
  fetchedAtMs: number;
} | null> {
  const snap = await env.RADAR_KV.get(KV_SNAPSHOT);
  if (snap) {
    try {
      const o = JSON.parse(snap) as { v?: number; body?: string; fetchedAtMs?: number };
      if (o.v === 1 && typeof o.body === "string" && typeof o.fetchedAtMs === "number") {
        const entries = parseTargetTimesBody(o.body);
        return { entries, fetchedAtMs: o.fetchedAtMs };
      }
    } catch {
      return null;
    }
  }

  const [legacyBody, legacyAt] = await Promise.all([
    env.RADAR_KV.get(KV_LEGACY_BODY),
    env.RADAR_KV.get(KV_LEGACY_AT),
  ]);
  if (!legacyBody || !legacyAt) return null;
  const fetchedAtMs = Number.parseInt(legacyAt, 10);
  if (!Number.isFinite(fetchedAtMs)) return null;
  try {
    const entries = parseTargetTimesBody(legacyBody);
    await writeSnapshot(env, legacyBody, fetchedAtMs);
    return { entries, fetchedAtMs };
  } catch {
    return null;
  }
}

export async function ingestNowc(env: Env, correlationId: string): Promise<void> {
  const body = await fetchJmaTargetTimesBody();
  parseTargetTimesBody(body);
  const now = Date.now();
  await writeSnapshot(env, body, now);
  console.log(
    JSON.stringify({
      outcome: "ingest_ok",
      correlation_id: correlationId,
      fetched_at_ms: now,
    }),
  );
}

function parseFrameParts(frameId: string): { basetime: string; validtime: string } | null {
  let id = frameId;
  try {
    id = decodeURIComponent(frameId);
  } catch {
    /* そのまま */
  }
  const idx = id.indexOf("_");
  if (idx <= 0 || idx === id.length - 1) return null;
  const basetime = id.slice(0, idx);
  const validtime = id.slice(idx + 1);
  if (!/^\d{14}$/.test(basetime) || !/^\d{14}$/.test(validtime)) return null;
  return { basetime, validtime };
}

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (productionFakeViolation(env)) {
      console.log(
        JSON.stringify({
          outcome: "scheduled_skip",
          reason: "production_fake_forbidden",
        }),
      );
      return;
    }
    if (isFakeEnabled(env)) {
      console.log(
        JSON.stringify({
          outcome: "scheduled_skip",
          reason: "fake_enabled",
        }),
      );
      return;
    }
    const correlationId = event.cron ?? "cron";
    try {
      await ingestNowc(env, correlationId);
    } catch (e) {
      console.log(
        JSON.stringify({
          outcome: "ingest_error",
          correlation_id: correlationId,
          message: String(e),
        }),
      );
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const correlationId = request.headers.get("x-correlation-id") || crypto.randomUUID();

    if (productionFakeViolation(env)) {
      return errorJson(
        request,
        env,
        503,
        "production_fake_forbidden",
        "本番ではフェイクプロバイダを有効にできません。",
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let originForMeta: string;
    try {
      originForMeta = apiOrigin(request, env);
    } catch (e) {
      return errorJson(request, env, 500, "config_error", String(e));
    }

    if (path === "/healthz" && request.method === "GET") {
      const snap = await readSnapshot(env);
      return jsonResponse(
        request,
        env,
        {
          ok: true,
          environment: env.ENVIRONMENT,
          fake_provider: isFakeEnabled(env),
          last_ingest_ms: snap ? snap.fetchedAtMs : null,
        },
        { cacheControl: "no-store" },
      );
    }

    if (path === "/api/v1/radar/meta" && request.method === "GET") {
      const zb = zoomBounds(env);

      if (isFakeEnabled(env)) {
        return jsonResponse(request, env, fakeMeta(originForMeta), {
          cacheControl: "no-store",
        });
      }

      let snap = await readSnapshot(env);
      if (!snap) {
        if (!isProduction(env)) {
          try {
            await ingestNowc(env, correlationId);
            snap = await readSnapshot(env);
          } catch (e) {
            return errorJson(
              request,
              env,
              503,
              "meta_unavailable",
              `上流の取得に失敗しました: ${String(e)}`,
            );
          }
        } else {
          return errorJson(
            request,
            env,
            503,
            "warming_up",
            "初回データを Cron で取得中です。数分後に再試行してください。",
            {
              cacheControl: "no-store",
              extraHeaders: { "Retry-After": "120" },
            },
          );
        }
      }

      if (!snap || snap.entries.length === 0) {
        return errorJson(request, env, 503, "meta_empty", "メタデータを構築できません。");
      }

      const meta = buildRadarMetaV1({
        apiOrigin: originForMeta,
        entries: snap.entries,
        fetchedAtMs: snap.fetchedAtMs,
        zoomMin: zb.min,
        zoomMax: zb.max,
      });

      return jsonResponse(request, env, meta, {
        cacheControl: "max-age=30, stale-while-revalidate=120",
      });
    }

    const tileMatch = /^\/tiles\/nowc\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
    if (tileMatch && request.method === "GET") {
      const [, frameId, zs, xs, ys] = tileMatch;
      const z = Number.parseInt(zs!, 10);
      const x = Number.parseInt(xs!, 10);
      const y = Number.parseInt(ys!, 10);
      const zb = zoomBounds(env);

      if (isFakeEnabled(env)) {
        if (frameId === "fake_frame") {
          return new Response(TRANSPARENT_PNG, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=60",
              ...corsHeaders(request, env),
            },
          });
        }
        return errorJson(request, env, 404, "tile_not_found", "不明なフレームです。");
      }

      const parts = parseFrameParts(frameId!);
      if (!parts) {
        return errorJson(request, env, 400, "invalid_frame_id", "frame_id の形式が不正です。");
      }
      if (z < zb.min || z > zb.max) {
        return errorJson(request, env, 404, "zoom_out_of_range", "ズームが範囲外です。", {
          cacheControl: "public, max-age=60",
        });
      }

      if (!tileIntersectsCoverageBbox(z, x, y, JAPAN_COVERAGE_BBOX)) {
        return errorJson(request, env, 404, "out_of_coverage", "coverage 外のタイルです。", {
          cacheControl: "public, max-age=300",
        });
      }

      const upstream = await fetchUpstreamTile(parts.basetime, parts.validtime, z, x, y);
      const headers = new Headers({
        ...corsHeaders(request, env),
      });
      if (upstream.ok) {
        headers.set("Content-Type", upstream.headers.get("Content-Type") || "image/png");
        headers.set("Cache-Control", "public, max-age=86400, immutable");
        return new Response(upstream.body, { status: 200, headers });
      }
      if (upstream.status === 404) {
        return errorJson(request, env, 404, "tile_not_found", "タイルが見つかりません。", {
          cacheControl: "public, max-age=60",
        });
      }
      return errorJson(
        request,
        env,
        502,
        "upstream_error",
        `上流がエラーを返しました: ${upstream.status}`,
      );
    }

    return errorJson(request, env, 404, "not_found", "パスが見つかりません。");
  },
};
