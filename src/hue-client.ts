import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { BridgeConfig } from "./config.js";

/**
 * Broen bruker et sertifikat utstedt av Signify sin egen rot-CA, som ingen operativsystemer stoler på.
 * I stedet for å slå av sjekken lagrer vi sertifikatets fingeravtrykk første gang (ved paring)
 * og krever det samme fingeravtrykket hver gang etterpå. Forbindelsen gis ikke videre før
 * fingeravtrykket er sjekket, så API-nøkkelen sendes aldri til en annen maskin.
 */
export class PinnedAgent extends https.Agent {
  constructor(
    private readonly fingerprint256: string,
    keepAlive = true,
  ) {
    super({ keepAlive, rejectUnauthorized: false });
    // Node kaller createConnection(options, callback); returnerer vi ingenting, venter den på callbacken.
    (this as unknown as { createConnection: unknown }).createConnection = (
      options: tls.ConnectionOptions,
      callback: (err: Error | null, socket?: Duplex) => void,
    ): undefined => {
      const socket = tls.connect({ ...options, rejectUnauthorized: false });
      let done = false;
      const finish = (err: Error | null) => {
        if (done) return;
        done = true;
        if (err) {
          socket.destroy();
          callback(err);
        } else {
          callback(null, socket);
        }
      };
      socket.once("secureConnect", () => {
        const fp = socket.getPeerCertificate().fingerprint256;
        if (fp !== this.fingerprint256) {
          finish(
            new Error(
              `Sertifikatet til broen har endret seg (fikk ${fp}). ` +
                "Hvis du har byttet bro, slett data/config.json og par på nytt.",
            ),
          );
        } else {
          finish(null);
        }
      });
      socket.once("error", (err) => finish(err));
      return undefined;
    };
  }
}

export interface PeerCertInfo {
  fingerprint256: string;
  commonName: string;
}

/** Kobler til broen én gang og leser sertifikatet, uten å sende noe. Brukes ved første paring. */
export function readBridgeCertificate(ip: string, timeoutMs = 5000): Promise<PeerCertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 443, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Fikk ikke svar fra ${ip}:443 innen ${timeoutMs / 1000} sekunder`));
    });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const cn = cert.subject?.CN;
      resolve({
        fingerprint256: cert.fingerprint256,
        commonName: (Array.isArray(cn) ? cn[0] : cn) ?? "",
      });
    });
    socket.once("error", reject);
  });
}

export interface RequestOptions {
  ip: string;
  agent: https.Agent;
  method?: string;
  path: string;
  appKey?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** Ett HTTPS-kall mot broen. Returnerer tolket JSON. */
export function bridgeRequest<T = unknown>(opts: RequestOptions): Promise<T> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: opts.ip,
        port: 443,
        method: opts.method ?? "GET",
        path: opts.path,
        agent: opts.agent,
        headers: {
          Accept: "application/json",
          ...(opts.appKey ? { "hue-application-key": opts.appKey } : {}),
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          if (status >= 400) {
            reject(new BridgeHttpError(status, opts.path, parsed));
          } else {
            resolve(parsed as T);
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 10_000, () => {
      req.destroy(new Error(`Tidsavbrudd mot broen (${opts.path})`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Broen svarte ${status} på ${path}: ${JSON.stringify(body)}`);
  }
}

/** En ressurs fra CLIP v2. Bare feltene vi bruker overalt er typet; resten varierer per type. */
export interface HueResource {
  id: string;
  type: string;
  id_v1?: string;
  owner?: { rid: string; rtype: string };
  metadata?: { name?: string; archetype?: string; control_id?: number };
  [key: string]: unknown;
}

interface ClipResponse<T> {
  errors: { description: string }[];
  data: T[];
}

/** Klient for en paret bro. */
export class HueClient {
  private readonly agent: PinnedAgent;

  constructor(readonly config: BridgeConfig) {
    this.agent = new PinnedAgent(config.certFingerprint256);
  }

  async getAllResources(): Promise<HueResource[]> {
    const res = await bridgeRequest<ClipResponse<HueResource>>({
      ip: this.config.bridgeIp,
      agent: this.agent,
      path: "/clip/v2/resource",
      appKey: this.config.appKey,
    });
    if (res.errors?.length) {
      throw new Error(`Broen svarte med feil: ${res.errors.map((e) => e.description).join(", ")}`);
    }
    return res.data;
  }

  /** Endrer en ressurs, f.eks. PUT /clip/v2/resource/grouped_light/<id> med {"on":{"on":true}}. */
  async put(type: string, id: string, body: unknown): Promise<void> {
    await this.resource("PUT", type, id, body);
  }

  /** Lager en ny ressurs (rom, sone, scene). Returnerer id-ene broen ga den. */
  async create(type: string, body: unknown): Promise<{ rid: string; rtype: string }[]> {
    return (await this.resource("POST", type, undefined, body)) as { rid: string; rtype: string }[];
  }

  async remove(type: string, id: string): Promise<void> {
    await this.resource("DELETE", type, id);
  }

  private async resource(method: string, type: string, id?: string, body?: unknown): Promise<unknown[]> {
    const path = `/clip/v2/resource/${encodeURIComponent(type)}${id ? `/${encodeURIComponent(id)}` : ""}`;
    let res: ClipResponse<unknown>;
    try {
      res = await bridgeRequest<ClipResponse<unknown>>({
        ip: this.config.bridgeIp,
        agent: this.agent,
        method,
        path,
        appKey: this.config.appKey,
        body,
      });
    } catch (err) {
      // Broen forklarer som regel hva som er galt i errors[]; det er mer nyttig enn statuskoden.
      const errors = (err instanceof BridgeHttpError && (err.body as ClipResponse<unknown>)?.errors) || [];
      if (errors.length) throw new Error(errors.map((e) => e.description).join(", "));
      throw err;
    }
    if (res?.errors?.length) {
      throw new Error(res.errors.map((e) => e.description).join(", "));
    }
    return res?.data ?? [];
  }

  /**
   * Lytter på /eventstream/clip/v2 og kobler til igjen ved brudd.
   * onConnected kalles hver gang strømmen (gjen)opprettes, slik at kalleren kan hente full tilstand.
   * Returnerer en funksjon som stopper lyttingen.
   */
  listen(handlers: {
    onEvents: (events: HueEvent[]) => void;
    onConnected?: () => void;
    onDisconnected?: (reason: string, retryInMs: number) => void;
  }): () => void {
    let stopped = false;
    let backoff = 1000;
    let current: ReturnType<typeof https.request> | null = null;
    let retryTimer: NodeJS.Timeout | null = null;
    // Egen agent uten keep-alive-gjenbruk, siden strømmen holder sin forbindelse for seg selv.
    const streamAgent = new PinnedAgent(this.config.certFingerprint256, false);

    const scheduleReconnect = (reason: string) => {
      current = null;
      if (stopped) return;
      handlers.onDisconnected?.(reason, backoff);
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };

    const connect = () => {
      retryTimer = null;
      if (stopped) return;
      let ended = false;
      const endOnce = (reason: string) => {
        if (ended) return;
        ended = true;
        scheduleReconnect(reason);
      };

      const req = https.request(
        {
          host: this.config.bridgeIp,
          port: 443,
          path: "/eventstream/clip/v2",
          agent: streamAgent,
          headers: {
            Accept: "text/event-stream",
            "hue-application-key": this.config.appKey,
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            endOnce(`HTTP ${res.statusCode}`);
            return;
          }
          backoff = 1000;
          handlers.onConnected?.();
          res.socket.setKeepAlive(true, 30_000);
          const parser = new SseParser((data) => {
            try {
              handlers.onEvents(JSON.parse(data) as HueEvent[]);
            } catch (err) {
              console.error("Klarte ikke å tolke hendelse:", (err as Error).message, data);
            }
          });
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => parser.push(chunk));
          res.on("end", () => endOnce("broen lukket strømmen"));
          res.on("error", (err) => endOnce(err.message));
        },
      );
      req.on("error", (err) => endOnce(err.message));
      req.end();
      current = req;
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.destroy();
      streamAgent.destroy();
    };
  }

  close(): void {
    this.agent.destroy();
  }
}

/** Én hendelse fra eventstream. data inneholder bare feltene som endret seg. */
export interface HueEvent {
  creationtime: string;
  id: string;
  type: "add" | "update" | "delete" | "error";
  data: HueResource[];
}

/** Minimal parser for Server-Sent Events: samler data-linjer til en tom linje avslutter hendelsen. */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.dataLines.length) {
          this.onData(this.dataLines.join("\n"));
          this.dataLines = [];
        }
      } else if (line.startsWith("data:")) {
        this.dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // id:, event: og kommentarer (":") trenger vi ikke.
    }
  }
}
