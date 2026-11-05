import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";

/**
 * Hvor huset ligger. Brukes til været fra yr (og senere tømmekalenderen).
 *
 * Settes med HJEM_ADRESSE (for eksempel «Storgata 1, 1234 Sted»), som slås opp hos Kartverket én gang
 * og huskes i data/hjem.json. HJEM_POSISJON («59.91,10.75») kan brukes i stedet, eller i tillegg for å
 * overstyre punktet.
 */
export interface HomeLocation {
  lat: number;
  lon: number;
  /** Adressen slik Kartverket skriver den, når den er slått opp. */
  address?: string;
  street?: string;
  houseNumber?: string;
  postcode?: string;
  place?: string;
  municipality?: string;
  municipalityNumber?: string;
}

const CACHE = () => path.join(dataDir, "hjem.json");
export const USER_AGENT = "hue-dashboard/1.0 github.com/mortennf-arch/hue-dashboard";

function parsePosition(text: string | undefined): { lat: number; lon: number } | null {
  const m = text?.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

interface KartverketAddress {
  adressetekst?: string;
  adressenavn?: string;
  nummer?: number;
  bokstav?: string;
  postnummer?: string;
  poststed?: string;
  kommunenavn?: string;
  kommunenummer?: string;
  representasjonspunkt?: { lat?: number; lon?: number };
}

const title = (s?: string) => s?.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());

async function geocode(address: string): Promise<HomeLocation> {
  const url = new URL("https://ws.geonorge.no/adresser/v1/sok");
  url.searchParams.set("sok", address);
  url.searchParams.set("treffPerSide", "1");
  url.searchParams.set("utkoordsys", "4258");
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Kartverket svarte ${res.status}`);
  const data = (await res.json()) as { adresser?: KartverketAddress[] };
  const a = data.adresser?.[0];
  const lat = a?.representasjonspunkt?.lat;
  const lon = a?.representasjonspunkt?.lon;
  if (!a || typeof lat !== "number" || typeof lon !== "number") throw new Error(`Fant ikke adressen «${address}» hos Kartverket`);
  return {
    lat,
    lon,
    address: [a.adressetekst, [a.postnummer, title(a.poststed)].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    street: a.adressenavn,
    houseNumber: a.nummer !== undefined ? `${a.nummer}${a.bokstav ?? ""}` : undefined,
    postcode: a.postnummer,
    place: title(a.poststed),
    municipality: title(a.kommunenavn),
    municipalityNumber: a.kommunenummer,
  };
}

export class Home {
  private cached: HomeLocation | null = null;
  private loading: Promise<HomeLocation | null> | null = null;
  private failedAt = 0;
  reason = "";

  constructor(
    private readonly address = (process.env.HJEM_ADRESSE ?? "").trim(),
    private readonly position = parsePosition(process.env.HJEM_POSISJON),
  ) {
    if (process.env.HJEM_POSISJON && !this.position) this.reason = "HJEM_POSISJON må skrives som «breddegrad,lengdegrad», for eksempel 59.91,10.75";
  }

  get configured(): boolean {
    return Boolean(this.address || this.position);
  }

  /** Finner hjemmet. Et mislykket oppslag prøves igjen tidligst etter fem minutter. */
  async get(): Promise<HomeLocation | null> {
    if (this.cached) return this.cached;
    if (!this.configured) {
      this.reason ||= "Sett HJEM_ADRESSE i appens miljøvariabler for å få været.";
      return null;
    }
    if (Date.now() - this.failedAt < 5 * 60_000) return null;
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(): Promise<HomeLocation | null> {
    let found: HomeLocation | null = null;
    if (this.address) {
      try {
        const saved = JSON.parse(await readFile(CACHE(), "utf8")) as { query?: string; home?: HomeLocation };
        if (saved.query === this.address && saved.home) found = saved.home;
      } catch {
        // ikke lagret ennå
      }
      if (!found) {
        try {
          found = await geocode(this.address);
          await writeFile(CACHE(), JSON.stringify({ query: this.address, home: found }, null, 2)).catch(() => {});
          console.log(`Hjem: fant «${found.address}» i ${found.municipality ?? "ukjent kommune"}`);
        } catch (err) {
          this.reason = (err as Error).message;
          console.log(`Hjem: ${this.reason}`);
          if (!this.position) {
            this.failedAt = Date.now();
            return null;
          }
        }
      }
    }
    if (this.position) found = { ...(found ?? {}), ...this.position };
    this.cached = found;
    this.reason = "";
    return found;
  }
}
