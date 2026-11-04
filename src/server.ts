import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HueClient, HueEvent } from "./hue-client.js";
import type { ResourceStore } from "./store.js";
import type { SonosManager, SonosState } from "./sonos.js";

/** Mappen med dashbordets filer (index.html, app.js, style.css). */
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const LIGHT_FIELDS = ["on", "dimming", "color", "color_temperature", "dynamics", "alert", "signaling"];
const RESOURCE_RULES: Record<string, { methods: string[]; fields: string[] }> = {
  light: {
    methods: ["PUT"],
    fields: [...LIGHT_FIELDS, "metadata", "effects", "effects_v2", "timed_effects", "powerup", "identify", "gradient"],
  },
  grouped_light: { methods: ["PUT"], fields: LIGHT_FIELDS },
  device: { methods: ["PUT"], fields: ["metadata", "identify"] },
  room: { methods: ["PUT", "POST", "DELETE"], fields: ["metadata", "children"] },
  zone: { methods: ["PUT", "POST", "DELETE"], fields: ["metadata", "children"] },
  scene: {
    methods: ["PUT", "POST", "DELETE"],
    fields: ["metadata", "group", "actions", "palette", "speed", "auto_dynamic", "recall"],
  },
};

export interface WebServer {
  broadcastEvents(events: HueEvent[]): void;
  broadcastSnapshot(): void;
  broadcastSonos(state: SonosState): void;
  setBridgeStatus(connected: boolean, reason?: string): void;
  close(): void;
}

/**
 * Broen tåler omtrent én kommando i sekundet per gruppe. Når noen drar i en glider, kommer det mange
 * endringer raskt. Vi slår dem sammen per ressurs og sender den siste verdien høyst én gang per intervall.
 */
class Throttle {
  private readonly pending = new Map<string, { body: Record<string, unknown>; send: (b: unknown) => Promise<void> }>();
  private readonly lastSent = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly intervalMs: number) {}

  submit(key: string, body: Record<string, unknown>, send: (b: unknown) => Promise<void>): void {
    const existing = this.pending.get(key);
    const merged: Record<string, unknown> = { ...(existing?.body ?? {}), ...body };
    // Farge og hvittone utelukker hverandre: den siste som ble valgt, vinner.
    if ("color" in body) delete merged.color_temperature;
    if ("color_temperature" in body) delete merged.color;
    this.pending.set(key, { body: merged, send });
    if (this.timers.has(key)) return;
    const wait = Math.max(0, (this.lastSent.get(key) ?? 0) + this.intervalMs - Date.now());
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const job = this.pending.get(key);
        this.pending.delete(key);
        if (!job) return;
        this.lastSent.set(key, Date.now());
        job.send(job.body).catch((err) => console.error(`Kommando til broen feilet (${key}):`, err.message));
      }, wait),
    );
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
  }
}

export async function startWebServer(opts: {
  port: number;
  client: HueClient;
  store: ResourceStore;
  sonos?: SonosManager;
}): Promise<WebServer> {
  const { client, store, sonos } = opts;
  const clients = new Set<http.ServerResponse>();
  const groupThrottle = new Throttle(1000);
  const lightThrottle = new Throttle(150);
  const sonosThrottle = new Throttle(250);
  let bridge = { connected: true, reason: "" };
  // De siste hendelsene, slik at et nyåpnet dashbord har noe i loggen med en gang.
  const recent: HueEvent[] = [];
  const snapshot = () => ({ bridge, resources: store.all(), recent, sonos: sonos?.current ?? null });

  const send = (res: http.ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) send(res, event, data);
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 10_000) {
          reject(new Error("For stor forespørsel"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed = text ? JSON.parse(text) : {};
          resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
        } catch {
          reject(new Error("Ugyldig JSON"));
        }
      });
      req.on("error", reject);
    });

  /** Bygger en Hue-kommando av et lite, kontrollert sett felter fra dashbordet. */
  const lightCommand = (body: Record<string, unknown>): Record<string, unknown> | null => {
    const cmd: Record<string, unknown> = {};
    if (typeof body.on === "boolean") cmd.on = { on: body.on };
    if (typeof body.brightness === "number" && Number.isFinite(body.brightness)) {
      cmd.dimming = { brightness: Math.min(100, Math.max(1, Math.round(body.brightness))) };
      if (body.on === undefined) cmd.on = { on: true };
    }
    const xy = body.xy as { x?: unknown; y?: unknown } | undefined;
    if (xy && typeof xy.x === "number" && typeof xy.y === "number" && xy.x >= 0 && xy.x <= 1 && xy.y > 0 && xy.y <= 1) {
      cmd.color = { xy: { x: Number(xy.x.toFixed(4)), y: Number(xy.y.toFixed(4)) } };
      if (body.on === undefined) cmd.on = { on: true };
    } else if (typeof body.mirek === "number" && Number.isFinite(body.mirek)) {
      cmd.color_temperature = { mirek: Math.min(500, Math.max(153, Math.round(body.mirek))) };
      if (body.on === undefined) cmd.on = { on: true };
    }
    return Object.keys(cmd).length ? cmd : null;
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, snapshot());
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      send(res, "snapshot", snapshot());
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return;
    }

    const control = url.pathname.match(/^\/api\/(grouped_light|light)\/([0-9a-f-]{36})$/);
    if (req.method === "PUT" && control) {
      const [, type, id] = control;
      if (store.get(id)?.type !== type) return json(res, 404, { error: "Fant ikke ressursen" });
      const cmd = lightCommand(await readBody(req));
      if (!cmd) return json(res, 400, { error: "Send on (true/false), brightness (1–100), xy ({x, y}) eller mirek (153–500)" });
      const throttle = type === "grouped_light" ? groupThrottle : lightThrottle;
      throttle.submit(`${type}/${id}`, cmd, (b) => client.put(type, id, b));
      return json(res, 202, { ok: true });
    }

    const scene = url.pathname.match(/^\/api\/scene\/([0-9a-f-]{36})\/recall$/);
    if (req.method === "POST" && scene) {
      const id = scene[1];
      if (store.get(id)?.type !== "scene") return json(res, 404, { error: "Fant ikke scenen" });
      await client.put("scene", id, { recall: { action: "active" } });
      return json(res, 200, { ok: true });
    }

    // Generell tilgang til broens ressurser for det appen ellers gjør: rom, soner, scener, navn, effekter.
    // Bare et lite sett typer og felter slipper gjennom.
    const generic = url.pathname.match(/^\/api\/resource\/([a-z_]+)(?:\/([0-9a-f-]{36}))?$/);
    if (generic && (req.method === "PUT" || req.method === "POST" || req.method === "DELETE")) {
      const [, type, id] = generic;
      const rule = RESOURCE_RULES[type];
      const method = req.method;
      if (!rule || !rule.methods.includes(method)) return json(res, 405, { error: "Ikke tillatt" });
      if ((method === "POST") === Boolean(id)) return json(res, 400, { error: "Feil adresse" });
      if (id && store.get(id)?.type !== type) return json(res, 404, { error: "Fant ikke ressursen" });
      if (method === "DELETE") {
        await client.remove(type, id!);
        return json(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const keys = Object.keys(body);
      const bad = keys.filter((k) => !rule.fields.includes(k));
      if (!keys.length || bad.length) {
        return json(res, 400, { error: `Felter som ikke er tillatt: ${bad.join(", ") || "(tomt)"}` });
      }
      if (method === "POST") return json(res, 201, { ok: true, created: await client.create(type, body) });
      await client.put(type, id!, body);
      return json(res, 200, { ok: true });
    }

    // Sonos: avspilling for et rom (en gruppe) og volum for gruppen eller én høyttaler.
    const sonosCmd = url.pathname.match(/^\/api\/sonos\/(group|player)\/([^/]+)\/([a-z]+)$/);
    if (sonosCmd) {
      if (!sonos) return json(res, 404, { error: "Sonos er ikke satt opp" });
      const [, kind, rawId, action] = sonosCmd;
      const id = decodeURIComponent(rawId);
      const exists = kind === "group" ? sonos.hasGroup(id) : sonos.hasPlayer(id);
      if (!exists) return json(res, 404, { error: kind === "group" ? "Fant ikke rommet" : "Fant ikke høyttaleren" });
      if (req.method === "POST" && kind === "group" && ["play", "pause", "next", "previous"].includes(action)) {
        await sonos.transport(id, action as "play" | "pause" | "next" | "previous");
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT" && action === "volume") {
        const body = await readBody(req);
        const cmd: { volume?: number; mute?: boolean } = {};
        if (typeof body.volume === "number" && Number.isFinite(body.volume)) cmd.volume = Math.min(100, Math.max(0, Math.round(body.volume)));
        if (typeof body.mute === "boolean") cmd.mute = body.mute;
        if (!Object.keys(cmd).length) return json(res, 400, { error: "Send volume (0–100) eller mute (true/false)" });
        sonosThrottle.submit(`${kind}/${id}`, cmd, (b) =>
          kind === "group" ? sonos.setGroupVolume(id, b as typeof cmd) : sonos.setPlayerVolume(id, b as typeof cmd),
        );
        return json(res, 202, { ok: true });
      }
      return json(res, 405, { error: "Ikke tillatt" });
    }

    if (req.method === "POST" && url.pathname === "/api/all-off") {
      // grouped_light som eies av bridge_home er «hele huset».
      const home = store.all().find((r) => r.type === "grouped_light" && r.owner?.rtype === "bridge_home");
      if (!home) return json(res, 404, { error: "Fant ikke gruppen for hele huset" });
      await client.put("grouped_light", home.id, { on: { on: false } });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "Ukjent adresse" });
  };

  const serveStatic = async (res: http.ServerResponse, url: URL) => {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Finnes ikke");
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const task = url.pathname.startsWith("/api/") ? handleApi(req, res, url) : serveStatic(res, url);
    task.catch((err: Error) => {
      console.error("Feil i webserveren:", err.message);
      if (!res.headersSent) json(res, 502, { error: err.message });
      else res.end();
    });
  });

  // Holder SSE-forbindelsene i live gjennom proxyer og NAT.
  const ping = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "0.0.0.0", () => resolve());
  });

  return {
    broadcastEvents: (events) => {
      recent.push(...events);
      if (recent.length > 200) recent.splice(0, recent.length - 200);
      broadcast("hue", events);
    },
    broadcastSnapshot: () => broadcast("snapshot", snapshot()),
    broadcastSonos: (state) => broadcast("sonos", state),
    setBridgeStatus: (connected, reason = "") => {
      if (bridge.connected === connected && bridge.reason === reason) return;
      bridge = { connected, reason };
      broadcast("bridge", bridge);
    },
    close: () => {
      clearInterval(ping);
      groupThrottle.close();
      lightThrottle.close();
      sonosThrottle.close();
      for (const res of clients) res.end();
      server.close();
    },
  };
}
