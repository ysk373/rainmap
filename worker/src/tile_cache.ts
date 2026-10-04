/**
 * 気象庁タイルのキャッシュ（Workers の caches.default）。
 * タイルは basetime/validtime/z/x/y ごとに変わらないので長めに持つ。
 * 取得・デコードに成功したタイルだけを put する（失敗はキャッシュしない。precip.ts 側で保証）。
 * Cache API はデータセンターごと（tiered cache なし）。
 */

import type { TileCache } from "./precip";

const TILE_CACHE_CONTROL = "public, max-age=86400";

export function workersTileCache(waitUntil?: (p: Promise<unknown>) => void): TileCache {
  return {
    async match(key: string): Promise<Uint8Array | null> {
      try {
        const hit = await caches.default.match(new Request(key));
        if (!hit || !hit.ok) return null;
        const bytes = new Uint8Array(await hit.arrayBuffer());
        return bytes.byteLength > 0 ? bytes : null;
      } catch {
        return null;
      }
    },
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const p = caches.default
        .put(
          new Request(key),
          new Response(bytes, {
            status: 200,
            headers: { "Content-Type": "image/png", "Cache-Control": TILE_CACHE_CONTROL },
          }),
        )
        .catch(() => undefined);
      if (waitUntil) waitUntil(p);
      else await p;
    },
  };
}
