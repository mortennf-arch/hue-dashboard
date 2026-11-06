import crypto from "node:crypto";
import net from "node:net";

/**
 * Roborocks lokale protokoll (TCP 58867), slik støvsugerne snakker den på hjemmenettet.
 *
 * Roborock har ikke dokumentert dette. Det er skrevet ut fra python-roborock (Apache-2.0), som
 * Home Assistant bruker, og node-red-contrib-roborock-local (MIT). Hver melding er en 17-byte
 * header (versjon, sekvens, tilfeldig tall, tidspunkt, protokoll), deretter kryptert JSON og CRC32.
 *
 * - «1.0»: AES-128-ECB med en nøkkel laget av tidspunktet, den lokale nøkkelen og et fast salt.
 * - «L01»: AES-256-GCM, der nonsene fra håndtrykket også inngår. Nyere fastvare bruker denne.
 *
 * Den lokale nøkkelen hentes én gang fra Roborocks sky (se roborock.ts).
 */

export const TCP_PORT = 58867;
const SALT = Buffer.from("TXdfu$jyZ#TZHsg4", "utf8");
const P = { HELLO: 0, HELLO_ACK: 1, PING: 2, REQUEST: 4 } as const;
export type Version = "1.0" | "L01";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Tidspunktet som heks, stokket om i rekkefølgen 5,6,3,7,1,2,0,4. */
function scrambledTime(ts: number): Buffer {
  const hex = (ts >>> 0).toString(16).padStart(8, "0");
  return Buffer.from([5, 6, 3, 7, 1, 2, 0, 4].map((i) => hex[i]).join(""), "utf8");
}

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};

export interface Nonces {
  connect: number;
  ack: number | null;
}

interface Header {
  version: string;
  seq: number;
  random: number;
  timestamp: number;
  protocol: number;
}

function keyMaterial(localKey: string, ts: number): Buffer {
  return Buffer.concat([scrambledTime(ts), Buffer.from(localKey, "utf8"), SALT]);
}

export function encrypt(plain: Buffer, localKey: string, h: Header, n: Nonces): Buffer {
  if (h.version === "L01") {
    const key = crypto.createHash("sha256").update(keyMaterial(localKey, h.timestamp)).digest();
    const iv = crypto.createHash("sha256").update(Buffer.concat([u32(h.seq), u32(h.random), u32(h.timestamp)])).digest().subarray(0, 12);
    const aad = Buffer.concat([u32(h.seq), u32(n.connect), ...(n.ack === null ? [] : [u32(n.ack)]), u32(h.random), u32(h.timestamp)]);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  const key = crypto.createHash("md5").update(keyMaterial(localKey, h.timestamp)).digest();
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

export function decrypt(data: Buffer, localKey: string, h: Header, n: Nonces): Buffer {
  if (h.version === "L01") {
    if (data.length < 16) throw new Error("For kort L01-melding");
    const key = crypto.createHash("sha256").update(keyMaterial(localKey, h.timestamp)).digest();
    const iv = crypto.createHash("sha256").update(Buffer.concat([u32(h.seq), u32(h.random), u32(h.timestamp)])).digest().subarray(0, 12);
    const aad = Buffer.concat([u32(h.seq), u32(n.connect), ...(n.ack === null ? [] : [u32(n.ack)]), u32(h.random), u32(h.timestamp)]);
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(aad);
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  }
  const key = crypto.createHash("md5").update(keyMaterial(localKey, h.timestamp)).digest();
  const d = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(data), d.final()]);
}

function header(h: Header, extra: number): Buffer {
  const b = Buffer.alloc(17 + extra);
  b.write(h.version, 0, 3, "ascii");
  b.writeUInt32BE(h.seq >>> 0, 3);
  b.writeUInt32BE(h.random >>> 0, 7);
  b.writeUInt32BE(h.timestamp >>> 0, 11);
  b.writeUInt16BE(h.protocol, 15);
  return b;
}

const prefixed = (body: Buffer) => Buffer.concat([u32(body.length), body]);

/** Håndtrykket slik python-roborock lager det: header og CRC, uten innhold. */
export function encodeHello(version: Version, nonce: number): Buffer {
  const b = header({ version, seq: 1, random: nonce, timestamp: Math.floor(Date.now() / 1000), protocol: P.HELLO }, 4);
  b.writeUInt32BE(crc32(b.subarray(0, 17)), 17);
  return prefixed(b);
}

/** Håndtrykket slik Roborock-appen lager det: header og «keepalive» i sekunder, uten CRC. */
export function encodeAppHello(version: Version, nonce: number, keepAlive = 10): Buffer {
  const b = header({ version, seq: 0, random: nonce, timestamp: 0, protocol: P.HELLO }, 4);
  b.writeUInt32BE(keepAlive, 17);
  return prefixed(b);
}

export function encodeControl(version: string, protocol: number, seq = 0): Buffer {
  return prefixed(header({ version, seq, random: 0, timestamp: 0, protocol }, 0));
}

export function encodeData(h: Header, payload: Buffer, localKey: string, n: Nonces): Buffer {
  const enc = encrypt(payload, localKey, h, n);
  const b = header(h, 2 + enc.length + 4);
  b.writeUInt16BE(enc.length, 17);
  enc.copy(b, 19);
  b.writeUInt32BE(crc32(b.subarray(0, b.length - 4)), b.length - 4);
  return prefixed(b);
}

export type Frame = (Header & { kind: "control"; extra: number | null }) | (Header & { kind: "data"; payload: Buffer });

export function parseBody(body: Buffer): Frame {
  if (body.length < 17) throw new Error("For kort melding");
  const h: Header = {
    version: body.toString("ascii", 0, 3),
    seq: body.readUInt32BE(3),
    random: body.readUInt32BE(7),
    timestamp: body.readUInt32BE(11),
    protocol: body.readUInt16BE(15),
  };
  if (body.length < 23) return { ...h, kind: "control", extra: body.length >= 21 ? body.readUInt32BE(17) : null };
  const len = body.readUInt16BE(17);
  if (19 + len + 4 !== body.length) throw new Error(`Lengden stemmer ikke (${body.length}, innhold ${len})`);
  if (crc32(body.subarray(0, body.length - 4)) !== body.readUInt32BE(body.length - 4)) throw new Error("Feil CRC");
  return { ...h, kind: "data", payload: body.subarray(19, 19 + len) };
}

/** Deler en TCP-strøm opp i meldinger. Hver melding starter med lengden som 4 byte. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 17 || len > 1 << 20) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export function encodeRpc(id: number, method: string, params: unknown, ts: number): Buffer {
  return Buffer.from(JSON.stringify({ dps: { "101": JSON.stringify({ id, method, params }) }, t: ts }), "utf8");
}

const rand = (min: number, max: number) => crypto.randomInt(min, max);

/**
 * Én TCP-forbindelse til én støvsuger. Prøver versjonen som virket sist først, deretter den andre,
 * og begge måtene å hilse på. Sender ping hvert 5. sekund, ellers lukker roboten forbindelsen.
 */
export class LocalConnection {
  private socket: net.Socket | null = null;
  private reader = new FrameReader();
  private nonces: Nonces = { connect: 0, ack: null };
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private hello: ((f: Frame) => void) | null = null;
  private ping: NodeJS.Timeout | null = null;
  private nextId = rand(10000, 30000);
  private seq = 1;
  version: Version | null = null;
  closed = false;

  constructor(
    readonly host: string,
    private readonly localKey: string,
    private readonly onPush: (dps: Record<string, unknown>) => void = () => {},
    private readonly onClose: () => void = () => {},
  ) {}

  get ready(): boolean {
    return Boolean(this.socket && this.version);
  }

  async open(preferred: Version | null, timeoutMs = 4000): Promise<Version> {
    const versions: Version[] = preferred === "L01" ? ["L01", "1.0"] : ["1.0", "L01"];
    let last: Error = new Error("Fikk ikke svar");
    for (const version of versions) {
      for (const style of ["python", "app"] as const) {
        try {
          await this.connectSocket(timeoutMs);
          await this.handshake(version, style, timeoutMs);
          this.version = version;
          this.ping = setInterval(() => this.socket?.write(encodeControl(version, P.PING)), 5000);
          this.ping.unref();
          return version;
        } catch (err) {
          last = err as Error;
          this.destroy(false);
          if ((err as NodeJS.ErrnoException).code) throw err; // ECONNREFUSED o.l.: ingen vits å prøve videre
        }
      }
    }
    throw last;
  }

  private connectSocket(timeoutMs: number): Promise<void> {
    this.reader = new FrameReader();
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: TCP_PORT });
      const fail = (err: Error) => {
        s.destroy();
        reject(err);
      };
      s.setTimeout(timeoutMs, () => fail(Object.assign(new Error(`Ingen svar fra ${this.host}`), { code: "ETIMEDOUT" })));
      s.once("error", fail);
      s.once("connect", () => {
        s.setTimeout(0);
        s.removeListener("error", fail);
        s.on("error", () => {});
        s.on("data", (c) => this.onData(c));
        s.on("close", () => {
          if (this.socket !== s) return;
          this.destroy(true);
        });
        this.socket = s;
        resolve();
      });
    });
  }

  private handshake(version: Version, style: "python" | "app", timeoutMs: number): Promise<void> {
    this.nonces = { connect: rand(10000, 32767), ack: null };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.hello = null;
        reject(new Error(`Ingen svar på håndtrykk (${version})`));
      }, timeoutMs);
      this.hello = (f) => {
        clearTimeout(timer);
        this.hello = null;
        if (style === "app" && f.kind === "control" && f.extra) return reject(new Error(`Håndtrykket ble avvist (${f.extra})`));
        this.nonces.ack = f.random;
        resolve();
      };
      this.socket!.write(style === "python" ? encodeHello(version, this.nonces.connect) : encodeAppHello(version, this.nonces.connect));
    });
  }

  private onData(chunk: Buffer): void {
    for (const body of this.reader.push(chunk)) {
      let f: Frame;
      try {
        f = parseBody(body);
      } catch {
        continue;
      }
      if (f.protocol === P.HELLO_ACK && this.hello) {
        this.hello(f);
        continue;
      }
      if (f.kind !== "data") continue;
      let msg: { dps?: Record<string, unknown> };
      try {
        msg = JSON.parse(decrypt(f.payload, this.localKey, f, this.nonces).toString("utf8"));
      } catch {
        continue; // feil nøkkel eller noe vi ikke forstår (for eksempel kartdata)
      }
      const dps = msg?.dps;
      if (!dps || typeof dps !== "object") continue;
      const raw = dps["102"];
      if (typeof raw === "string") {
        let rpc: { id?: number; result?: unknown; error?: { message?: string; code?: number } | string };
        try {
          rpc = JSON.parse(raw);
        } catch {
          continue;
        }
        const waiter = rpc.id !== undefined ? this.pending.get(Number(rpc.id)) : undefined;
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(Number(rpc.id));
          if (rpc.error) waiter.reject(new Error(typeof rpc.error === "string" ? rpc.error : `${rpc.error.message ?? "feil"} (${rpc.error.code ?? "?"})`));
          else if (rpc.result === "unknown_method") waiter.reject(new Error("Støvsugeren kjenner ikke kommandoen"));
          else waiter.resolve(rpc.result);
        }
      } else {
        this.onPush(dps);
      }
    }
  }

  request<T = unknown>(method: string, params: unknown = [], timeoutMs = 8000): Promise<T> {
    if (!this.socket || !this.version) return Promise.reject(new Error("Ikke tilkoblet"));
    const id = (this.nextId = this.nextId >= 32767 ? 10000 : this.nextId + 1);
    const seq = (this.seq = this.seq >= 65535 ? 1 : this.seq + 1);
    const ts = Math.floor(Date.now() / 1000);
    const frame = encodeData({ version: this.version, seq, random: rand(1, 0x7fffffff), timestamp: ts, protocol: P.REQUEST }, encodeRpc(id, method, params, ts), this.localKey, this.nonces);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Ingen svar på ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket!.write(frame);
    });
  }

  private destroy(notify: boolean): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const s = this.socket;
    this.socket = null;
    const wasReady = this.version !== null;
    this.version = null;
    s?.removeAllListeners("data");
    s?.destroy();
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(new Error("Forbindelsen ble brutt"));
    }
    this.pending.clear();
    if (notify && wasReady && !this.closed) this.onClose();
  }

  close(): void {
    this.closed = true;
    this.destroy(false);
  }
}

/** Ser etter maskiner med port 58867 åpen. Docker-nettet slipper ikke gjennom UDP-kunngjøringene, så vi spør i stedet. */
export async function scanForVacuums(hosts: string[], timeoutMs = 600, parallel = 96): Promise<string[]> {
  const found: string[] = [];
  let i = 0;
  const probe = (host: string) =>
    new Promise<void>((resolve) => {
      const s = net.connect({ host, port: TCP_PORT });
      const done = (ok: boolean) => {
        if (ok) found.push(host);
        s.destroy();
        resolve();
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once("error", () => done(false));
      s.once("connect", () => done(true));
    });
  await Promise.all(
    Array.from({ length: Math.min(parallel, hosts.length) }, async () => {
      while (i < hosts.length) await probe(hosts[i++]);
    }),
  );
  return found;
}
