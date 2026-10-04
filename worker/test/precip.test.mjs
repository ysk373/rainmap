// RAINMAP-2: alerts/precip の fail-closed（B1）を fake の fetchTile で確かめる。
// 実行: cd worker && npm test（= tsc -p tsconfig.test.json && node --test test/）
// （追加の依存なし: TypeScript は既存の devDependency、テストは Node 20 の node:test）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { evaluatePrecipAtPoint, precipHttpResult, PRECIP_OK_CACHE_CONTROL } = require(
  "../dist/test-build/precip.js",
);

// ---- 最小の RGBA PNG（256x256 単色）を作る ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng([r, g, b, a], size = 256) {
  const w = size;
  const h = size;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 4);
    raw[o] = 0; // filter none
    for (let x = 0; x < w; x++) raw.set([r, g, b, a], o + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const DRY_PNG = solidPng([0, 0, 0, 0]); // 透明 = 無降水
const TINY_PNG = solidPng([0, 0, 0, 0], 1); // 1x1（気象庁のタイルではない）
const GARBAGE = Buffer.from("not a png");
const RAIN_PNG = solidPng([0x21, 0x8c, 0xff, 255]); // 7.5 mm/h

// ---- コマ: 解析（いま）＋ 5 分刻みの予報 4 コマ ----
const NOW_MS = Date.parse("2026-10-05T00:00:00Z");
const BASE = "20261005000000";
const vt = (min) => {
  const d = new Date(NOW_MS + min * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
};
const entriesAt = (mins) => mins.map((m) => ({ basetime: BASE, validtime: vt(m), elements: ["hrpns"] }));
const ENTRIES = entriesAt([0, 5, 10, 15, 20]);

/** validtime（分）→ 応答 の表から fake fetchTile を作る */
function fakeFetch(table) {
  return async (_basetime, validtime, _z, _x, _y, signal) => {
    const min = Math.round((Date.parse(
      `${validtime.slice(0, 4)}-${validtime.slice(4, 6)}-${validtime.slice(6, 8)}T${validtime.slice(8, 10)}:${validtime.slice(10, 12)}:00Z`,
    ) - NOW_MS) / 60_000);
    const r = table[min];
    if (r === "throw") throw new TypeError("network down");
    if (r === "hang") {
      // signal を無視して返らない上流（全体の時間の上限で timeout にならないといけない）
      void signal;
      return new Promise(() => {});
    }
    if (typeof r === "number") return new Response("err", { status: r });
    if (r === "empty") return new Response(new Uint8Array(0), { status: 200 });
    return new Response(r, { status: 200, headers: { "Content-Type": "image/png" } });
  };
}

/** caches.default の代わり（N1: 成功したタイルだけ put される） */
function memoryCache() {
  const map = new Map();
  return {
    map,
    async match(key) {
      return map.get(key) ?? null;
    },
    async put(key, bytes) {
      map.set(key, bytes);
    },
  };
}

function evaluate(table, extra = {}) {
  return evaluatePrecipAtPoint({
    lat: 35.0,
    lon: 135.0,
    entries: ENTRIES,
    fetchedAtMs: NOW_MS,
    nowMs: NOW_MS,
    horizonMinutes: 60,
    minIntensityMmh: 1,
    zoom: 8,
    zoomMin: 4,
    zoomMax: 10,
    radiusPx: 2,
    fetchTile: fakeFetch(table),
    ...extra,
  });
}

test("全部成功: complete=true、通知あり、200＋キャッシュ可", async () => {
  const cache = memoryCache();
  const ev = await evaluate(
    { 0: DRY_PNG, 5: DRY_PNG, 10: DRY_PNG, 15: RAIN_PNG, 20: RAIN_PNG },
    { tileCache: cache },
  );
  assert.equal(ev.ok, true);
  const a = ev.alert;
  assert.equal(a.complete, true);
  assert.deepEqual(a.failed_frames, []);
  assert.equal(a.samples.length, 5);
  assert.ok(a.samples.every((s) => s.ok === true && s.error === null && typeof s.intensity_mmh === "number"));
  assert.equal(a.currently_raining, false);
  assert.equal(a.notify_recommended, true);
  assert.equal(a.eta_minutes, 15);
  const r = precipHttpResult(ev);
  assert.equal(r.status, 200);
  assert.equal(r.cacheControl, PRECIP_OK_CACHE_CONTROL);

  // N1: 2 回目は上流に行かずキャッシュから同じ結果になる
  assert.equal(cache.map.size, 5);
  const again = await evaluate({ 0: "throw", 5: "throw", 10: "throw", 15: "throw", 20: "throw" }, { tileCache: cache });
  assert.equal(again.ok, true);
  assert.equal(again.alert.complete, true);
  assert.equal(again.alert.notify_recommended, true);
});

test("一部失敗（予報コマの HTTP エラー・例外・時間切れ・壊れた PNG・空の本文）: complete=false、通知しない、200＋no-store", { timeout: 5_000 }, async () => {
  const cache = memoryCache();
  const ev = await evaluate(
    { 0: DRY_PNG, 5: 500, 10: "throw", 15: RAIN_PNG, 20: "hang", 25: GARBAGE, 30: "empty", 35: TINY_PNG, 40: 404 },
    { budgetMs: 300, tileCache: cache, entries: entriesAt([0, 5, 10, 15, 20, 25, 30, 35, 40]) },
  );
  assert.equal(ev.ok, true);
  const a = ev.alert;
  assert.equal(a.complete, false);
  assert.equal(a.notify_recommended, false); // 15 分後に雨でも、失敗があるので false
  assert.deepEqual(
    a.failed_frames.map((f) => [f.time, f.error, f.http_status]),
    [
      ["2026-10-05T00:05:00.000Z", "http_error", 500],
      ["2026-10-05T00:10:00.000Z", "fetch_error", null],
      ["2026-10-05T00:20:00.000Z", "timeout", null],
      ["2026-10-05T00:25:00.000Z", "decode_error", null],
      ["2026-10-05T00:30:00.000Z", "fetch_error", null],
      ["2026-10-05T00:35:00.000Z", "decode_error", null],
      ["2026-10-05T00:40:00.000Z", "http_error", 404],
    ],
  );
  assert.equal(a.currently_raining, false);
  assert.equal(a.raining_soon, true); // 成功したコマ（15 分後）だけから計算
  // 失敗したコマはキャッシュしない（成功した 2 コマだけ）
  assert.equal(cache.map.size, 2);
  const failed = a.samples.filter((s) => !s.ok);
  assert.equal(failed.length, 7);
  assert.ok(failed.every((s) => s.intensity_mmh === null && s.raining === null && s.intensity_label === null));
  const r = precipHttpResult(ev);
  assert.equal(r.status, 200);
  assert.equal(r.cacheControl, "no-store");
});

test("全部失敗・解析コマ失敗・現在コマなし: 502 upstream_error＋no-store（雨なしとして返さない）", async () => {
  const all = await evaluate({ 0: 503, 5: "throw", 10: 500, 15: 404, 20: 502 });
  assert.equal(all.ok, false);
  assert.equal(all.error.error_code, "upstream_error");
  assert.equal(all.error.reason, "all_frames_failed");
  assert.equal(all.error.complete, false);
  assert.equal(all.error.failed_frames.length, 5);
  let r = precipHttpResult(all);
  assert.equal(r.status, 502);
  assert.equal(r.cacheControl, "no-store");

  // 解析コマだけ 503、予報は雨 → 「もうすぐ雨」と誤通知しない
  const cur = await evaluate({ 0: 503, 5: RAIN_PNG, 10: RAIN_PNG, 15: RAIN_PNG, 20: RAIN_PNG });
  assert.equal(cur.ok, false);
  assert.equal(cur.error.reason, "current_frame_failed");
  assert.deepEqual(
    cur.error.failed_frames.map((f) => [f.role, f.error, f.http_status]),
    [["analysis", "http_error", 503]],
  );
  r = precipHttpResult(cur);
  assert.equal(r.status, 502);
  assert.equal(r.cacheControl, "no-store");

  // 壊れたキャッシュがヒットしても 0 mm/h にしない（解析コマ → 502）
  const bad = { async match() { return new Uint8Array(GARBAGE); }, async put() {} };
  const corrupt = await evaluate({ 0: "throw", 5: RAIN_PNG }, { tileCache: bad, entries: entriesAt([0, 5]) });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.error.reason, "all_frames_failed");
  assert.ok(corrupt.error.failed_frames.every((f) => f.error === "decode_error"));

  // 現在時刻以前のコマが無い（未来だけ）、評価するコマが無い → no_current_frame
  for (const entries of [entriesAt([5, 10]), []]) {
    const none = await evaluate({ 5: RAIN_PNG, 10: RAIN_PNG }, { entries });
    assert.equal(none.ok, false);
    assert.equal(none.error.reason, "no_current_frame");
    assert.equal(precipHttpResult(none).status, 502);
  }
});
