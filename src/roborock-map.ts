import crypto from "node:crypto";
import zlib from "node:zlib";
import { crc32 } from "./roborock-protocol.js";

/**
 * Kartet fra en Roborock-støvsuger, i formatet appen også bruker (gzip-et «RR»-kart med blokker).
 * Lest slik vacuum-map-parser-roborock (Home Assistant) leser det, og gjort om til et lite PNG-bilde
 * pluss vei, støvsuger, lader og rom som tegnes oppå i nettleseren.
 */

export interface MapView {
  /** Bildet, beskåret til selve leiligheten. Én piksel = 5 cm. */
  w: number;
  h: number;
  png: string;
  /** Veien den har kjørt, som x,y,x,y … i bildets piksler. */
  path: number[];
  robot: { x: number; y: number; a: number | null } | null;
  charger: { x: number; y: number } | null;
  /** Midtpunktet for hvert rom, for navnet. */
  rooms: { segment: number; x: number; y: number }[];
}

const i16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const i32 = (b: Buffer, o: number) => b.readUInt32LE(o);

interface Point {
  x: number;
  y: number;
  a?: number | null;
}

export interface ParsedMap {
  width: number;
  height: number;
  top: number;
  left: number;
  pixels: Buffer;
  path: Point[];
  robot: Point | null;
  charger: Point | null;
}

function position(len: number, d: Buffer): Point {
  let a: number | null = null;
  if (len > 8) {
    a = i32(d, 8);
    if (a > 0xff) a = (a & 0xff) - 256;
  }
  return { x: i32(d, 0), y: i32(d, 4), a };
}

export function parseRRMap(raw: Buffer): ParsedMap {
  if (raw.length < 0x14 || raw.toString("ascii", 0, 2) !== "rr") throw new Error("Ukjent kartformat");
  const out: ParsedMap = { width: 0, height: 0, top: 0, left: 0, pixels: Buffer.alloc(0), path: [], robot: null, charger: null };
  let pos = i16(raw, 2);
  while (pos + 8 <= raw.length) {
    const type = i16(raw, pos);
    const hlen = i16(raw, pos + 2);
    const dlen = i32(raw, pos + 4);
    const header = raw.subarray(pos, pos + hlen);
    const data = raw.subarray(pos + hlen, pos + hlen + dlen);
    switch (type) {
      case 1:
        out.charger = position(dlen, data);
        break;
      case 2:
        out.top = i32(header, hlen - 16);
        out.left = i32(header, hlen - 12);
        out.height = i32(header, hlen - 8);
        out.width = i32(header, hlen - 4);
        out.pixels = Buffer.from(data);
        break;
      case 3: {
        // Veien: punkter på 4 byte rett etter en header på 0x14 byte.
        const start = pos + 0x14;
        for (let p = start; p + 4 <= start + dlen && p + 4 <= raw.length; p += 4) out.path.push({ x: i16(raw, p), y: i16(raw, p + 2) });
        break;
      }
      case 8:
        out.robot = position(dlen, data);
        break;
    }
    if (hlen <= 0) break;
    pos += hlen + dlen;
  }
  if (out.pixels.length < out.width * out.height) throw new Error("Kartbildet er ufullstendig");
  return out;
}

// Farger i samme stil som dashbordet: dempede rom, lyse vegger.
const ROOM_COLORS = ["#2F6F8F", "#5B4E8C", "#3E7A5A", "#8C6A3A", "#7A3E5E", "#3A6E7A", "#6E7A3A", "#4E5B8C"];
const WALL = "#9AA3B2";
const FLOOR = "#2A3040";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Et palett-PNG. Indeks 0 er gjennomsiktig. */
export function encodePng(width: number, height: number, idx: Uint8Array, palette: string[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(idx.buffer, idx.byteOffset + y * width, width).copy(rows, y * (width + 1) + 1);
  const trns = Buffer.alloc(palette.length, 255);
  trns[0] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(palette.flatMap(rgb))),
    chunk("tRNS", trns),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Gjør kartet om til det nettleseren trenger: et beskåret bilde og punkter i bildets koordinater. */
export function renderMap(m: ParsedMap): MapView {
  const { width: W, height: H, pixels } = m;
  // Finn området med noe i, og legg på litt marg.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const roomBox = new Map<number, [number, number, number, number]>();
  for (let ry = 0; ry < H; ry++) {
    const y = H - 1 - ry;
    for (let x = 0; x < W; x++) {
      const v = pixels[x + W * ry];
      if (v === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (v !== 0xff && v !== 0x07 && (v & 7) === 7) {
        const n = v >> 3;
        const b = roomBox.get(n);
        if (!b) roomBox.set(n, [x, y, x, y]);
        else {
          if (x < b[0]) b[0] = x;
          if (y < b[1]) b[1] = y;
          if (x > b[2]) b[2] = x;
          if (y > b[3]) b[3] = y;
        }
      }
    }
  }
  if (x1 < 0) throw new Error("Kartet er tomt");
  const M = 3;
  x0 = Math.max(0, x0 - M);
  y0 = Math.max(0, y0 - M);
  x1 = Math.min(W - 1, x1 + M);
  y1 = Math.min(H - 1, y1 + M);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const rooms = [...roomBox.keys()].sort((a, b) => a - b);
  const palette = ["#000000", WALL, FLOOR, ...rooms.map((n) => ROOM_COLORS[n % ROOM_COLORS.length])];
  const roomIndex = new Map(rooms.map((n, i) => [n, 3 + i]));
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ry = H - 1 - (y + y0);
    for (let x = 0; x < w; x++) {
      const v = pixels[x + x0 + W * ry];
      let c = 0;
      if (v === 0) c = 0;
      else if (v === 1) c = 1;
      else if (v === 0xff || v === 0x07) c = 2;
      else if ((v & 7) === 7) c = roomIndex.get(v >> 3) ?? 2;
      else if ((v & 7) === 1 || (v & 7) === 0) c = 1;
      else c = 2;
      idx[x + w * y] = c;
    }
  }
  // Kartets enhet er mm; én piksel er 50 mm. Bildet er speilvendt i høyden.
  const tx = (p: Point) => Math.round((p.x / 50 - m.left - x0) * 10) / 10;
  const ty = (p: Point) => Math.round((H - 1 - (p.y / 50 - m.top) - y0) * 10) / 10;
  const path: number[] = [];
  for (const p of m.path) path.push(tx(p), ty(p));
  return {
    w,
    h,
    png: encodePng(w, h, idx, palette).toString("base64"),
    path,
    robot: m.robot ? { x: tx(m.robot), y: ty(m.robot), a: m.robot.a ?? null } : null,
    charger: m.charger ? { x: tx(m.charger), y: ty(m.charger) } : null,
    rooms: rooms.map((n) => {
      const b = roomBox.get(n)!;
      return { segment: n, x: (b[0] + b[2]) / 2 - x0, y: (b[1] + b[3]) / 2 - y0 };
    }),
  };
}

/** Sikkerhetsdelen som følger med get_map_v1: hvem som spør, og nøkkelen svaret krypteres med. */
export function securityData(rriotK: string): { endpoint: string; nonce: Buffer } {
  const endpoint = crypto.createHash("md5").update(rriotK, "utf8").digest().subarray(8, 14).toString("base64");
  return { endpoint, nonce: crypto.randomBytes(16) };
}

/** Pakker ut et kartsvar (protokoll 301): 24 byte header, så AES-CBC med nonce, så gzip. */
export function decodeMapPayload(payload: Buffer, endpoint: string, nonce: Buffer): { requestId: number; data: Buffer } | null {
  if (payload.length < 24) throw new Error("For kort kartsvar");
  if (!payload.subarray(0, 8).toString("latin1").startsWith(endpoint)) return null;
  const requestId = payload.readUInt16LE(16);
  const d = crypto.createDecipheriv("aes-128-cbc", nonce, Buffer.alloc(16));
  const plain = Buffer.concat([d.update(payload.subarray(24)), d.final()]);
  return { requestId, data: zlib.gunzipSync(plain) };
}
