import zlib from "zlib";

/**
 * 検証用の PNG をその場で生成する。
 *
 * 以前は自己診断のテスト画像に外部サイトのURLを決め打ちしていたが、
 * その画像が消えて 404 になり、「Xへのアップロードが通るのか」という
 * 肝心の検証が一切できていない状態になっていた。
 * 自己診断が第三者の都合で壊れるのは本末転倒なので、依存を断つ。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 指定サイズのグラデーションPNGを作る（RGB 8bit、非圧縮フィルタ） */
export function makeTestPng(size = 256): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // フィルタタイプ: None
    for (let x = 0; x < size; x++) {
      raw[offset++] = (x * 255) / size; // R
      raw[offset++] = (y * 255) / size; // G
      raw[offset++] = ((x ^ y) & 0xff); // B（模様を入れて圧縮されすぎるのを防ぐ）
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
