import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, type BridgeConfig } from "./config.js";
import { HueClient, type HueEvent, type HueResource } from "./hue-client.js";

/** Holder full tilstand i minnet og fletter inn endringer fra eventstream. */
export class ResourceStore {
  private readonly byId = new Map<string, HueResource>();

  replaceAll(resources: HueResource[]): void {
    this.byId.clear();
    for (const r of resources) this.byId.set(r.id, r);
  }

  apply(event: HueEvent): void {
    for (const r of event.data) {
      if (event.type === "delete") {
        this.byId.delete(r.id);
      } else if (event.type === "add" || !this.byId.has(r.id)) {
        this.byId.set(r.id, r);
      } else {
        deepMerge(this.byId.get(r.id)!, r);
      }
    }
  }

  get(id: string): HueResource | undefined {
    return this.byId.get(id);
  }

  all(): HueResource[] {
    return [...this.byId.values()];
  }

  /** Et lesbart navn: ressursens eget navn, ellers navnet på enheten eller rommet som eier den. */
  label(r: HueResource): string {
    const own = r.metadata?.name;
    if (own) return own;
    const stored = this.byId.get(r.id);
    if (stored?.metadata?.name) return stored.metadata.name;
    const owner = (r.owner ?? stored?.owner) as HueResource["owner"];
    const ownerRes = owner ? this.byId.get(owner.rid) : undefined;
    const ownerName = ownerRes?.metadata?.name;
    const controlId = stored?.metadata?.control_id ?? r.metadata?.control_id;
    if (ownerName && controlId !== undefined) return `${ownerName}, knapp ${controlId}`;
    if (ownerName) return ownerName;
    return r.id.slice(0, 8);
  }
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && t && typeof t === "object" && !Array.isArray(t)) {
      deepMerge(t as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

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

/** Kobler til, viser full tilstand og skriver ut alle hendelser live til du trykker Ctrl+C. */
export async function watch(cfg: BridgeConfig): Promise<void> {
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
  console.log("Lytter på hendelser. Skru på et lys, trykk på en bryter eller ring på døra. Ctrl+C avslutter.");
  console.log("");

  let connectedOnce = false;
  const stop = client.listen({
    onConnected: () => {
      if (connectedOnce) {
        console.log(`${time()}  Koblet til igjen, henter full tilstand ...`);
        refresh(false).catch((err) => console.error("Klarte ikke å hente tilstand:", err.message));
      }
      connectedOnce = true;
    },
    onDisconnected: (reason, retryInMs) => {
      console.log(`${time()}  Mistet forbindelsen (${reason}). Prøver igjen om ${retryInMs / 1000} s.`);
    },
    onEvents: (events) => {
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
    },
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      stop();
      client.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
