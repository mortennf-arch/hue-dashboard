import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, type BridgeConfig } from "./config.js";
import { HueClient, type HueResource } from "./hue-client.js";
import { ResourceStore } from "./store.js";
import { startWebServer, type WebServer } from "./server.js";
import { SonosManager } from "./sonos.js";
import { SpotifyClient } from "./spotify.js";
import { VerisureClient } from "./verisure.js";
import { WeatherService } from "./weather.js";
import { WasteCalendar } from "./waste.js";

const SKIP_KEYS = new Set(["id", "id_v1", "type", "owner", "service_id"]);

/** Gjør endrede felter om til korte "sti=verdi"-par, f.eks. on.on=false dimming.brightness=40. */
function describeChange(r: HueResource): string {
  const parts: string[] = [];
  const walk = (obj: unknown, prefix: string) => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        if (!prefix && SKIP_KEYS.has(k)) continue;
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    } else {
      parts.push(`${prefix}=${JSON.stringify(obj)}`);
    }
  };
  walk(r, "");
  const text = parts.join(" ");
  return text.length > 200 ? text.slice(0, 197) + "..." : text;
}

function time(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString("nb-NO", { hour12: false });
}

function printSummary(store: ResourceStore, cfg: BridgeConfig): void {
  const counts = new Map<string, number>();
  for (const r of store.all()) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);

  console.log("");
  console.log(`Broen ${cfg.bridgeId ?? ""} på ${cfg.bridgeIp} har ${store.all().length} ressurser:`);
  for (const [type, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${type.padEnd(32)} ${n}`);
  }

  console.log("");
  console.log("Enheter:");
  const devices = store.all().filter((r) => r.type === "device");
  devices.sort((a, b) => store.label(a).localeCompare(store.label(b), "nb"));
  for (const d of devices) {
    const pd = (d.product_data ?? {}) as { product_name?: string; model_id?: string };
    const services = ((d.services ?? []) as { rtype: string }[]).map((s) => s.rtype);
    console.log(
      `  ${store.label(d).padEnd(30)} ${(pd.product_name ?? "").padEnd(28)} ${(pd.model_id ?? "").padEnd(10)} ${[...new Set(services)].join(", ")}`,
    );
  }
  console.log("");
}

const MAX_LOG_BYTES = 20 * 1024 * 1024;

/** Flytter events.jsonl til events.1.jsonl når den blir for stor, slik at disken ikke fylles opp. */
async function rotateIfLarge(file: string): Promise<void> {
  try {
    if ((await stat(file)).size > MAX_LOG_BYTES) await rename(file, file.replace(/\.jsonl$/, ".1.jsonl"));
  } catch {
    // Filen finnes ikke ennå.
  }
}

/**
 * Kobler til, viser full tilstand og skriver ut alle hendelser live til du trykker Ctrl+C.
 * Med web.port startes også dashbordet, som får tilstand og hendelser live.
 */
export async function watch(cfg: BridgeConfig, opts: { web?: { port: number } } = {}): Promise<void> {
  const client = new HueClient(cfg);
  const store = new ResourceStore();
  await mkdir(dataDir, { recursive: true });
  const eventLog = path.join(dataDir, "events.jsonl");
  const snapshotPath = path.join(dataDir, "resources.json");

  const refresh = async (first: boolean) => {
    const resources = await client.getAllResources();
    store.replaceAll(resources);
    await writeFile(snapshotPath, JSON.stringify(resources, null, 2));
    if (first) {
      printSummary(store, cfg);
      console.log(`Full tilstand er lagret i ${snapshotPath}.`);
      console.log(`Alle hendelser lagres også i ${eventLog}.`);
    }
  };

  await refresh(true);
  await rotateIfLarge(eventLog);
  let web: WebServer | null = null;
  let sonos: SonosManager | null = null;
  if (opts.web && process.env.SONOS !== "off") {
    let lastReason: string | null = null;
    sonos = new SonosManager((state) => {
      web?.broadcastSonos(state);
      if (state.reason !== lastReason) {
        lastReason = state.reason;
        if (state.reason) console.log(`${time()}  Sonos: ${state.reason}`);
        else console.log(`${time()}  Sonos: ${state.groups.flatMap((g) => g.members).length} høyttalere i ${state.groups.length} grupper`);
      }
    });
  }
  let verisure: VerisureClient | null = null;
  if (opts.web) {
    let lastStatus = "";
    let listed = false;
    const v = new VerisureClient((state) => {
      web?.broadcastVerisure(state);
      if (state.status !== lastStatus) {
        lastStatus = state.status;
        console.log(`${time()}  Verisure: ${state.status === "ok" ? "tilkoblet" : state.reason || state.status}`);
      }
      if (state.status === "ok" && !listed) {
        listed = true;
        const n = (label: string, list: unknown[]) => (list.length ? `${list.length} ${label}` : "");
        const parts = [n("dør/vindu", state.doors), n("temperaturmålere", state.climate), n("låser", state.locks), n("smartplugger", state.plugs), n("personer", state.people)].filter(Boolean);
        console.log(`${time()}  Verisure «${state.installation}»: ${parts.join(", ") || "ingen enheter funnet"}`);
      }
    });
    if (v.configured) verisure = v;
    web = await startWebServer({ port: opts.web.port, client, store, sonos: sonos ?? undefined, spotify: new SpotifyClient(), verisure: verisure ?? undefined, weather: new WeatherService(), waste: new WasteCalendar() });
    console.log(`Dashbordet kjører på http://localhost:${opts.web.port} (og på maskinens IP-adresse).`);
    sonos?.start().catch((err) => console.error("Sonos:", err.message));
    verisure?.start().catch((err) => console.error("Verisure:", err.message));
  }
  console.log("Lytter på hendelser. Skru på et lys, trykk på en bryter eller ring på døra. Ctrl+C avslutter.");
  console.log("");

  let connectedOnce = false;
  let eventCount = 0;
  const stop = client.listen({
    onConnected: () => {
      if (connectedOnce) {
        console.log(`${time()}  Koblet til igjen, henter full tilstand ...`);
        refresh(false)
          .then(() => web?.broadcastSnapshot())
          .catch((err) => console.error("Klarte ikke å hente tilstand:", err.message));
      }
      connectedOnce = true;
      web?.setBridgeStatus(true);
    },
    onDisconnected: (reason, retryInMs) => {
      console.log(`${time()}  Mistet forbindelsen (${reason}). Prøver igjen om ${retryInMs / 1000} s.`);
      web?.setBridgeStatus(false, reason);
    },
    onEvents: (events) => {
      if (++eventCount % 500 === 0) rotateIfLarge(eventLog).catch(() => {});
      for (const ev of events) {
        appendFile(eventLog, JSON.stringify(ev) + "\n").catch(() => {});
        for (const r of ev.data) {
          // Navnet slås opp før endringen flettes inn, slik at slettede ressurser også får navn.
          const label = store.label(r);
          console.log(
            `${time(ev.creationtime)}  ${ev.type.padEnd(6)}  ${r.type.padEnd(22)}  ${label.padEnd(28)}  ${describeChange(r)}`,
          );
        }
        store.apply(ev);
      }
      web?.broadcastEvents(events);
    },
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      stop();
      sonos?.stop();
      verisure?.stop();
      web?.close();
      client.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
