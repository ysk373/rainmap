/**
 * 最小 PNG デコーダ（JMA HRPNs タイル向け）。
 * - color type 3（indexed, 4/8-bit）+ tRNS
 * - color type 6（RGBA 8-bit）… 空タイルの透明プレースホルダ
 */

export type DecodedPng = {
  width: number;
  height: number;
  /** 長さ width*height。indexed はパレット index、RGBA はパック済みではない別配列を使う */
  indices: Uint8Array | null;
  /** RGBA8888、長さ width*height*4。indexed の場合は展開済み */
  rgba: Uint8Array;
};

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRows(
  raw: Uint8Array,
  height: number,
  bytesPerRow: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(height * bytesPerRow);
  let src = 0;
  let prev = new Uint8Array(bytesPerRow);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!;
    const cur = raw.subarray(src, src + bytesPerRow);
    src += bytesPerRow;
    const row = new Uint8Array(bytesPerRow);
    for (let i = 0; i < bytesPerRow; i++) {
      const x = cur[i]!;
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = (x + a) & 255;
          break;
        case 2:
          v = (x + b) & 255;
          break;
        case 3:
          v = (x + ((a + b) >> 1)) & 255;
          break;
        case 4:
          v = (x + paethPredictor(a, b, c)) & 255;
          break;
        default:
          throw new Error(`png_unknown_filter:${filter}`);
      }
      row[i] = v;
    }
    out.set(row, y * bytesPerRow);
    prev = row;
  }
  return out;
}

function expandIndexed4(
  packed: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
): Uint8Array {
  const indices = new Uint8Array(width * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const rowOff = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const byte = packed[rowOff + (x >> 1)]!;
      indices[o++] = x & 1 ? byte & 0x0f : byte >> 4;
    }
  }
  return indices;
}

function paletteToRgba(
  indices: Uint8Array,
  plte: Uint8Array,
  trns: Uint8Array,
): Uint8Array {
  const rgba = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!;
    const p = idx * 3;
    const o = i * 4;
    rgba[o] = plte[p] ?? 0;
    rgba[o + 1] = plte[p + 1] ?? 0;
    rgba[o + 2] = plte[p + 2] ?? 0;
    rgba[o + 3] = idx < trns.length ? trns[idx]! : 255;
  }
  return rgba;
}

/** PNG バイナリをデコードする。非対応形式は例外。 */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error("png_invalid_signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let plte: Uint8Array | null = null;
  let trns = new Uint8Array(0);
  const idatParts: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const len = readUint32(bytes, offset);
    offset += 4;
    const type = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    offset += 4;
    if (offset + len + 4 > bytes.length) throw new Error("png_truncated_chunk");
    const data = bytes.subarray(offset, offset + len);
    offset += len + 4; // data + CRC

    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "PLTE") {
      plte = data.slice();
    } else if (type === "tRNS") {
      trns = data.slice();
    } else if (type === "IDAT") {
      idatParts.push(data.slice());
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height) throw new Error("png_missing_ihdr");
  if (width > 1024 || height > 1024) throw new Error("png_too_large");

  let idatLen = 0;
  for (const p of idatParts) idatLen += p.length;
  const idat = new Uint8Array(idatLen);
  let idatOff = 0;
  for (const p of idatParts) {
    idat.set(p, idatOff);
    idatOff += p.length;
  }
  const inflated = await inflateZlib(idat);

  if (colorType === 3) {
    if (!plte) throw new Error("png_missing_plte");
    if (bitDepth !== 4 && bitDepth !== 8) {
      throw new Error(`png_unsupported_bit_depth:${bitDepth}`);
    }
    const bpp = 1; // filter 用のバイト単位（サンプル未満は 1）
    const bytesPerRow =
      bitDepth === 8 ? width : Math.ceil((width * bitDepth) / 8);
    const packed = unfilterRows(inflated, height, bytesPerRow, bpp);
    const indices =
      bitDepth === 8
        ? (() => {
            const out = new Uint8Array(width * height);
            for (let y = 0; y < height; y++) {
              out.set(packed.subarray(y * bytesPerRow, y * bytesPerRow + width), y * width);
            }
            return out;
          })()
        : expandIndexed4(packed, width, height, bytesPerRow);
    return {
      width,
      height,
      indices,
      rgba: paletteToRgba(indices, plte, trns),
    };
  }

  if (colorType === 6 && bitDepth === 8) {
    const bytesPerPixel = 4;
    const bytesPerRow = width * bytesPerPixel;
    const rgba = unfilterRows(inflated, height, bytesPerRow, bytesPerPixel);
    return { width, height, indices: null, rgba };
  }

  throw new Error(`png_unsupported_color_type:${colorType}`);
}
