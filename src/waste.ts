import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { USER_AGENT } from "./home.js";

/**
 * Tømmekalenderen fra kommunen. Foreløpig Stavanger: TOMMEKALENDER_URL er lenken man får på
 * stavanger.kommune.no etter å ha søkt opp adressen (…/finn-kalender/show?id=…&gnumber=…).
 * Siden er HTML, så datoene leses ut av tabellen. Hentes to ganger i døgnet og huskes i
 * data/tommekalender.json, slik at kalenderen vises selv om kommunens side er nede en stund.
 */

const REFRESH_MS = 12 * 3600_000;
const RETRY_MS = 30 * 60_000;
const CACHE = () => path.join(dataDir, "tommekalender.json");

export interface WastePickup {
  date: string; // ÅÅÅÅ-MM-DD
  types: string[];
}

export interface WasteState {
  configured: boolean;
  available: boolean;
  reason: string;
  updated: string | null;
  pickups: WastePickup[];
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&aring;/g, "å")
    .replace(/&Aring;/g, "Å")
    .replace(/&oslash;/g, "ø")
    .replace(/&Oslash;/g, "Ø")
    .replace(/&aelig;/g, "æ")
    .replace(/&AElig;/g, "Æ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/**
 * Leser tømmedatoene ut av Stavanger kommunes kalenderside. Hver rad har «dd.mm - ukedag» og ett bilde
 * per avfallstype (title/alt, for eksempel «Restavfall», «Mat», «Hage», «Papp/papir»). Radene har ikke
 * årstall, men kommer i rekkefølge fra i dag og fremover, så året regnes ut av det.
 * Forklaringen nederst på siden har også bilder, men ingen dato, så den hoppes over. Eksportert for testing.
 */
export function parseStavanger(html: string, now = new Date()): WastePickup[] {
  const out = new Map<string, Set<string>>();
  let year: number | null = null;
  let lastMonth = 0;
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1];
    const text = decode(row.replace(/<[^>]+>/g, " "));
    const d = text.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s*-/);
    if (!d) continue; // overskriftsraden
    const month = Number(d[2]);
    if (year === null) {
      // Uten årstall: kalenderen starter rundt dagens dato.
      year = now.getFullYear();
      if (month < now.getMonth() + 1 - 6) year++;
      else if (month > now.getMonth() + 1 + 6) year--;
    } else if (month < lastMonth) year++;
    lastMonth = month;
    const date = `${d[3] ?? year}-${String(month).padStart(2, "0")}-${d[1].padStart(2, "0")}`;
    const types = [...row.matchAll(/<img\b[^>]*?\b(?:title|alt)="([^"]+)"/gi)].map((x) => decode(x[1]).trim()).filter(Boolean);
    if (!types.length) continue;
    const set = out.get(date) ?? new Set<string>();
    for (const t of types) set.add(t);
    out.set(date, set);
  }
  return [...out].map(([date, set]) => ({ date, types: [...set] })).sort((a, b) => a.date.localeCompare(b.date));
}

const todayOslo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

export class WasteCalendar {
  private pickups: WastePickup[] = [];
  private updated: string | null = null;
  private fetchedAt = 0;
  private reason = "";
  private loading: Promise<void> | null = null;
  private loadedCache = false;

  constructor(private readonly url = (process.env.TOMMEKALENDER_URL ?? "").trim().replace(/&amp;/g, "&")) {}

  get configured(): boolean {
    return Boolean(this.url);
  }

  async state(): Promise<WasteState> {
    if (!this.configured) return { configured: false, available: false, reason: "", updated: null, pickups: [] };
    if (!this.loadedCache) await this.readCache();
    if (Date.now() - this.fetchedAt >= (this.reason ? RETRY_MS : REFRESH_MS)) {
      this.loading ??= this.refresh().finally(() => (this.loading = null));
      if (!this.pickups.length) await this.loading;
    }
    const today = todayOslo();
    const pickups = this.pickups.filter((p) => p.date >= today).slice(0, 12);
    return { configured: true, available: pickups.length > 0, reason: pickups.length ? "" : this.reason || "Fant ingen tømmedatoer", updated: this.updated, pickups };
  }

  private async readCache(): Promise<void> {
    this.loadedCache = true;
    try {
      const saved = JSON.parse(await readFile(CACHE(), "utf8")) as { url?: string; updated?: string; pickups?: WastePickup[] };
      if (saved.url === this.url && Array.isArray(saved.pickups)) {
        this.pickups = saved.pickups;
        this.updated = saved.updated ?? null;
        this.fetchedAt = saved.updated ? Date.parse(saved.updated) || 0 : 0;
      }
    } catch {
      // ikke lagret ennå
    }
  }

  private async refresh(): Promise<void> {
    this.fetchedAt = Date.now();
    try {
      let url: URL;
      try {
        url = new URL(this.url);
      } catch {
        throw new Error("TOMMEKALENDER_URL er ikke en gyldig lenke");
      }
      // Kommunens egen oppskrift sender id både som «id» og «ids».
      const id = url.searchParams.get("id") ?? url.searchParams.get("ids");
      if (id) {
        url.searchParams.set("id", id);
        url.searchParams.set("ids", id);
      }
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Referer: "https://www.stavanger.kommune.no", Accept: "text/html" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`kommunen svarte ${res.status}`);
      const pickups = parseStavanger(await res.text());
      if (!pickups.length) throw new Error("fant ingen datoer på kommunens side");
      this.pickups = pickups;
      this.updated = new Date().toISOString();
      if (this.reason) console.log("Tømmekalender: hentet igjen");
      else console.log(`Tømmekalender: ${pickups.length} tømmedager, neste ${pickups.find((p) => p.date >= todayOslo())?.date ?? "ukjent"}`);
      this.reason = "";
      await writeFile(CACHE(), JSON.stringify({ url: this.url, updated: this.updated, pickups }, null, 2)).catch(() => {});
    } catch (err) {
      const msg = `Fikk ikke hentet tømmekalenderen (${(err as Error).message})`;
      if (msg !== this.reason) console.log(`Tømmekalender: ${msg}`);
      this.reason = msg;
    }
  }
}
