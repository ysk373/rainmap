/**
 * 本番相当の上流タイルで PNG デコードと地点サンプリングを手動確認する。
 * 使い方: node scripts/probe-precip.mjs [lat] [lon]
 */
import { inflate } from "node:zlib";
import { promisify } from "node:util";

const inflateAsync = promisify(inflate);

const lat = Number(process.argv[2] || 35.681236);
const lon = Number(process.argv[3] || 139.767125);
const z = 8;

function latLonToTilePixel(lat, lon, z, tileSize = 256) {
  const n = 2 ** z;
  const xFloat = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFloat = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xFloat);
  const y = Math.floor(yFloat);
  const px = Math.min(tileSize - 1, Math.max(0, Math.floor((xFloat - x) * tileSize)));
  const py = Math.min(tileSize - 1, Math.max(0, Math.floor((yFloat - y) * tileSize)));
  return { x, y, px, py };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "rainmap-probe/0.3" } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function decodeIndexedPng(bytes) {
  // 簡易: Worker の png.ts と同じ経路を本番で確認するため、まずサイズと種別だけ見る
  const res = await fetch("data:application/octet-stream;base64," + Buffer.from(bytes).toString("base64"));
  void res;
  if (bytes[0] !== 0x89) throw new Error("not png");
  let offset = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0;
  let plte = null;
  let trns = new Uint8Array(0);
  const idatParts = [];
  const view = bytes;
  while (offset + 8 <= view.length) {
    const len = view.readUInt32BE(offset);
    offset += 4;
    const type = view.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const data = view.subarray(offset, offset + len);
    offset += len + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idatParts.push(Buffer.from(data));
    else if (type === "IEND") break;
  }
  const idat = Buffer.concat(idatParts);
  const raw = await inflateAsync(idat);
  return { width, height, bitDepth, colorType, plteEntries: plte ? plte.length / 3 : 0, trns: [...trns], rawLen: raw.length };
}

const n1 = await fetchJson("https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json");
const n2 = await fetchJson("https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json");
const tile = latLonToTilePixel(lat, lon, z);
const frames = [...n1.slice(0, 1), ...n2.slice(0, 6)];
console.log({ lat, lon, z, tile, n1: n1.length, n2: n2.length });

for (const e of frames) {
  const url = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${e.basetime}/none/${e.validtime}/surf/hrpns/${z}/${tile.x}/${tile.y}.png`;
  const res = await fetch(url, { headers: { "User-Agent": "rainmap-probe/0.3" } });
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await decodeIndexedPng(buf);
  const role = e.basetime === e.validtime ? "analysis" : "forecast";
  console.log(role, e.validtime, "http", res.status, "bytes", buf.length, meta);
}
