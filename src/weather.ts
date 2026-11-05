import { Home, USER_AGENT } from "./home.js";

/**
 * Været fra yr (Meteorologisk institutt, api.met.no). Varselet hentes på nytt når MET sier at det er
 * utløpt (Expires), og aldri oftere enn hvert tiende minutt, slik vilkårene deres ber om.
 * Data fra MET Norway, lisens CC BY 4.0.
 */

const API = process.env.MET_URL ?? "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const TZ = "Europe/Oslo";
const MIN_MS = 10 * 60_000;
const WET_MM = 0.2; // under dette regnes timen som opphold

export interface WeatherHour {
  time: string;
  temp: number;
  symbol: string;
  precip: number;
}

export interface WeatherDay {
  date: string; // ÅÅÅÅ-MM-DD i norsk tid
  min: number;
  max: number;
  symbol: string;
  precip: number;
  wind: number;
}

export interface WeatherState {
  available: boolean;
  reason: string;
  place: string;
  updated: string | null;
  now: (WeatherHour & { text: string; wind: number; gust: number | null; humidity: number | null }) | null;
  /** Kort om nedbøren de neste timene, for eksempel «Regn fra kl. 15». */
  note: string;
  hours: WeatherHour[];
  days: WeatherDay[];
}

interface MetEntry {
  time: string;
  data: {
    instant: { details: Record<string, number> };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_12_hours?: { summary?: { symbol_code?: string } };
  };
}

const TEXT: Record<string, string> = {
  clearsky: "Klarvær",
  fair: "Lettskyet",
  partlycloudy: "Delvis skyet",
  cloudy: "Skyet",
  fog: "Tåke",
  lightrainshowers: "Lette regnbyger",
  rainshowers: "Regnbyger",
  heavyrainshowers: "Kraftige regnbyger",
  lightrain: "Lett regn",
  rain: "Regn",
  heavyrain: "Kraftig regn",
  lightsleetshowers: "Lette sluddbyger",
  sleetshowers: "Sluddbyger",
  heavysleetshowers: "Kraftige sluddbyger",
  lightsleet: "Lett sludd",
  sleet: "Sludd",
  heavysleet: "Kraftig sludd",
  lightsnowshowers: "Lette snøbyger",
  snowshowers: "Snøbyger",
  heavysnowshowers: "Kraftige snøbyger",
  lightsnow: "Lett snø",
  snow: "Snø",
  heavysnow: "Kraftig snø",
};

export function symbolText(symbol: string): string {
  const base = symbol.replace(/_(day|night|polartwilight)$/, "");
  const thunder = base.endsWith("andthunder");
  const text = TEXT[thunder ? base.slice(0, -"andthunder".length) : base] ?? "";
  return thunder ? `${text} og torden` : text;
}

const kind = (symbol: string) => (/snow/.test(symbol) ? "Snø" : /sleet/.test(symbol) ? "Sludd" : "Regn");

const localParts = (() => {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  return (iso: string) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  };
})();

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Gjør MET-varselet om til det skjermene viser. Eksportert for testing. */
export function summarize(series: MetEntry[], now = Date.now()): Pick<WeatherState, "now" | "note" | "hours" | "days"> {
  // Første punkt er timen vi er i nå.
  const start = series.findIndex((e, i) => new Date(series[i + 1]?.time ?? e.time).getTime() > now);
  const list = start > 0 ? series.slice(start) : series;
  const first = list[0];
  if (!first) return { now: null, note: "", hours: [], days: [] };

  const hours: WeatherHour[] = [];
  for (const e of list) {
    const h1 = e.data.next_1_hours;
    if (!h1?.summary?.symbol_code) break; // etter et par døgn kommer bare 6-timers steg
    hours.push({ time: e.time, temp: round1(e.data.instant.details.air_temperature), symbol: h1.summary.symbol_code, precip: h1.details?.precipitation_amount ?? 0 });
    if (hours.length >= 24) break;
  }

  const d = first.data.instant.details;
  const firstSymbol = first.data.next_1_hours?.summary?.symbol_code ?? first.data.next_6_hours?.summary?.symbol_code ?? "cloudy";
  const nowState = {
    time: first.time,
    temp: round1(d.air_temperature),
    symbol: firstSymbol,
    precip: first.data.next_1_hours?.details?.precipitation_amount ?? 0,
    text: symbolText(firstSymbol),
    wind: round1(d.wind_speed ?? 0),
    gust: typeof d.wind_speed_of_gust === "number" ? round1(d.wind_speed_of_gust) : null,
    humidity: typeof d.relative_humidity === "number" ? Math.round(d.relative_humidity) : null,
  };

  // Nedbør de neste tolv timene.
  const next = hours.slice(0, 12);
  const at = (h: WeatherHour) => `kl. ${String(localParts(h.time).hour).padStart(2, "0")}`;
  let note = "";
  if (next.length) {
    if (next[0].precip >= WET_MM) {
      const dry = next.findIndex((h) => h.precip < WET_MM);
      note = dry === -1 ? `${kind(next[0].symbol)} de neste timene` : `Opphold fra ${at(next[dry])}`;
    } else {
      const wet = next.find((h) => h.precip >= WET_MM);
      note = wet ? `${kind(wet.symbol)} fra ${at(wet)}` : "Opphold de neste timene";
    }
  }

  // Dagene: høyeste og laveste temperatur, nedbør summert uten å telle samme time to ganger,
  // og symbolet for ettermiddagen (eller det nærmeste som finnes).
  const byDate = new Map<string, { temps: number[]; precip: number; wind: number; symbols: { hour: number; symbol: string }[] }>();
  let coveredUntil = 0;
  for (const e of list) {
    const t = new Date(e.time).getTime();
    const { date, hour } = localParts(e.time);
    let day = byDate.get(date);
    if (!day) byDate.set(date, (day = { temps: [], precip: 0, wind: 0, symbols: [] }));
    day.temps.push(e.data.instant.details.air_temperature);
    day.wind = Math.max(day.wind, e.data.instant.details.wind_speed ?? 0);
    if (t >= coveredUntil) {
      if (e.data.next_1_hours) {
        day.precip += e.data.next_1_hours.details?.precipitation_amount ?? 0;
        coveredUntil = t + 3600_000;
      } else if (e.data.next_6_hours) {
        day.precip += e.data.next_6_hours.details?.precipitation_amount ?? 0;
        coveredUntil = t + 6 * 3600_000;
      }
    }
    const sym = e.data.next_6_hours?.summary?.symbol_code ?? e.data.next_1_hours?.summary?.symbol_code;
    if (sym) day.symbols.push({ hour, symbol: sym });
  }
  const days: WeatherDay[] = [];
  for (const [date, v] of byDate) {
    if (!v.symbols.length) continue;
    const best = v.symbols.reduce((a, b) => (Math.abs(b.hour - 13) < Math.abs(a.hour - 13) ? b : a));
    days.push({ date, min: Math.round(Math.min(...v.temps)), max: Math.round(Math.max(...v.temps)), symbol: best.symbol, precip: round1(v.precip), wind: round1(v.wind) });
    if (days.length >= 7) break;
  }
  return { now: nowState, note, hours, days };
}

export class WeatherService {
  private series: MetEntry[] = [];
  private expires = 0;
  private lastModified = "";
  private fetchedAt = 0;
  private updated: string | null = null;
  private reason = "";
  private loading: Promise<void> | null = null;

  constructor(private readonly home = new Home()) {}

  get configured(): boolean {
    return this.home.configured;
  }

  async state(): Promise<WeatherState> {
    if (Date.now() >= Math.max(this.expires, this.fetchedAt + MIN_MS)) {
      this.loading ??= this.refresh().finally(() => (this.loading = null));
      // Første gang venter vi på svaret. Senere vises det vi har mens nytt varsel hentes.
      if (!this.series.length) await this.loading;
    }
    const home = await this.home.get();
    const base = { place: home?.place ?? home?.municipality ?? "", updated: this.updated };
    if (!this.series.length) {
      return { available: false, reason: this.reason || this.home.reason || "Henter været …", ...base, now: null, note: "", hours: [], days: [] };
    }
    return { available: true, reason: "", ...base, ...summarize(this.series) };
  }

  private async refresh(): Promise<void> {
    const home = await this.home.get();
    if (!home) {
      this.reason = this.home.reason;
      return;
    }
    this.fetchedAt = Date.now();
    const url = new URL(API);
    // MET ber om høyst fire desimaler, slik at svarene kan mellomlagres.
    url.searchParams.set("lat", home.lat.toFixed(4));
    url.searchParams.set("lon", home.lon.toFixed(4));
    try {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
      if (this.lastModified) headers["If-Modified-Since"] = this.lastModified;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      const expires = Date.parse(res.headers.get("expires") ?? "");
      this.expires = Number.isFinite(expires) ? expires : Date.now() + 30 * 60_000;
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`yr svarte ${res.status}`);
      const data = (await res.json()) as { properties?: { meta?: { updated_at?: string }; timeseries?: MetEntry[] } };
      const series = data.properties?.timeseries;
      if (!series?.length) throw new Error("yr sendte et tomt varsel");
      this.series = series;
      this.updated = data.properties?.meta?.updated_at ?? new Date().toISOString();
      this.lastModified = res.headers.get("last-modified") ?? "";
      if (this.reason) console.log("Været: hentet igjen");
      this.reason = "";
    } catch (err) {
      const msg = `Fikk ikke hentet været (${(err as Error).message})`;
      if (msg !== this.reason) console.log(`Været: ${msg}`);
      this.reason = msg;
      this.expires = Date.now() + 5 * 60_000;
    }
  }
}
