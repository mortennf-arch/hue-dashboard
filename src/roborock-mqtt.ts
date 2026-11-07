import net from "node:net";
import tls from "node:tls";

/**
 * En liten MQTT 3.1.1-klient, akkurat nok til Roborocks sky: koble til, abonnere, sende og ta imot.
 * Vi trenger den bare for kartet, som støvsugeren ikke sender over hjemmenettet.
 * Skrevet selv for å slippe en avhengighet i Docker-bildet.
 */

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, SUBSCRIBE = 8, PINGREQ = 12, DISCONNECT = 14;

export interface MqttOptions {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  clientId: string;
  keepAlive?: number;
}

const str = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

function remainingLength(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

const packet = (first: number, body: Buffer) => Buffer.concat([Buffer.from([first]), remainingLength(body.length), body]);

export function encodeConnect(o: MqttOptions): Buffer {
  const flags = 0x80 | 0x40 | 0x02; // brukernavn, passord, ren økt
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(o.keepAlive ?? 60);
  return packet(CONNECT << 4, Buffer.concat([str("MQTT"), Buffer.from([4, flags]), ka, str(o.clientId), str(o.username), str(o.password)]));
}

export function encodePublish(topic: string, payload: Buffer): Buffer {
  return packet(PUBLISH << 4, Buffer.concat([str(topic), payload]));
}

export function encodeSubscribe(id: number, topics: string[]): Buffer {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  return packet((SUBSCRIBE << 4) | 0x02, Buffer.concat([pid, ...topics.map((t) => Buffer.concat([str(t), Buffer.from([1])]))]));
}

/** Deler en strøm i MQTT-pakker. */
export class PacketReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): { type: number; flags: number; body: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { type: number; flags: number; body: Buffer }[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0, mul = 1, i = 1, done = false;
      while (i < this.buf.length && i <= 4) {
        const b = this.buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (!(b & 0x80)) {
          done = true;
          break;
        }
      }
      if (!done || this.buf.length < i + len) break;
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.subarray(i, i + len) });
      this.buf = this.buf.subarray(i + len);
    }
    return out;
  }
}

export class MqttClient {
  private socket: net.Socket | null = null;
  private reader = new PacketReader();
  private ping: NodeJS.Timeout | null = null;
  private nextId = 1;
  private subs = new Set<string>();
  ready = false;
  closed = false;

  constructor(
    private readonly o: MqttOptions,
    private readonly onMessage: (topic: string, payload: Buffer) => void,
    private readonly onClose: (reason: string) => void = () => {},
  ) {}

  connect(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail("Tidsavbrudd mot Roborocks sky"), timeoutMs);
      const sock = this.o.tls ? tls.connect({ host: this.o.host, port: this.o.port, servername: this.o.host }) : net.connect({ host: this.o.host, port: this.o.port });
      this.socket = sock;
      sock.on(this.o.tls ? "secureConnect" : "connect", () => sock.write(encodeConnect(this.o)));
      sock.on("data", (chunk) => {
        for (const p of this.reader.push(chunk)) {
          if (p.type === CONNACK) {
            clearTimeout(timer);
            const code = p.body[1];
            if (code !== 0) return fail(code === 4 || code === 5 ? "Roborocks sky godtok ikke innloggingen" : `Roborocks sky svarte med kode ${code}`);
            settled = true;
            this.ready = true;
            const ms = (this.o.keepAlive ?? 60) * 500;
            this.ping = setInterval(() => this.socket?.write(Buffer.from([PINGREQ << 4, 0])), ms);
            this.ping.unref?.();
            if (this.subs.size) sock.write(encodeSubscribe(this.id(), [...this.subs]));
            resolve();
          } else if (p.type === PUBLISH) {
            try {
              this.handlePublish(p.flags, p.body);
            } catch (e) {
              console.error("Roborock: ugyldig melding fra skyen:", (e as Error).message);
            }
          }
          // SUBACK, PUBACK og PINGRESP trenger vi ikke gjøre noe med.
        }
      });
      sock.on("error", (e) => fail(e.message));
      sock.on("close", () => {
        clearTimeout(timer);
        const was = this.ready;
        this.ready = false;
        if (this.ping) clearInterval(this.ping);
        this.ping = null;
        if (!settled) fail("Roborocks sky lukket forbindelsen");
        else if (was && !this.closed) this.onClose("Mistet forbindelsen til Roborocks sky");
      });
    });
  }

  private id(): number {
    this.nextId = (this.nextId % 65535) + 1;
    return this.nextId;
  }

  private handlePublish(flags: number, body: Buffer): void {
    const qos = (flags >> 1) & 3;
    const tlen = body.readUInt16BE(0);
    const topic = body.toString("utf8", 2, 2 + tlen);
    let off = 2 + tlen;
    if (qos > 0) {
      const pid = body.readUInt16BE(off);
      off += 2;
      const ack = Buffer.alloc(4);
      ack[0] = PUBACK << 4;
      ack[1] = 2;
      ack.writeUInt16BE(pid, 2);
      this.socket?.write(ack);
    }
    this.onMessage(topic, body.subarray(off));
  }

  subscribe(topic: string): void {
    if (this.subs.has(topic)) return;
    this.subs.add(topic);
    if (this.ready) this.socket?.write(encodeSubscribe(this.id(), [topic]));
  }

  publish(topic: string, payload: Buffer): void {
    if (!this.ready || !this.socket) throw new Error("Ikke koblet til Roborocks sky");
    this.socket.write(encodePublish(topic, payload));
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(Buffer.from([DISCONNECT << 4, 0]));
      } catch {}
      this.socket.destroy();
    }
    this.socket = null;
  }
}
