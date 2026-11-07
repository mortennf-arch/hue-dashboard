import crypto from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { LocalConnection, scanForVacuums, type Version } from "./roborock-protocol.js";

/**
 * Roborock-støvsugere i dashbordet.
 *
 * Roborock har ikke noe offisielt API. Første gang logger man inn med e-posten til Roborock-appen
 * og en kode som kommer på e-post. Da henter serveren støvsugerne, rommene og en lokal nøkkel per
 * støvsuger fra skyen deres. Alt dette lagres i roborock.json i datasettet. Etter det snakker serveren
 * direkte med støvsugerne på hjemmenettet (se roborock-protocol.ts), og skyen brukes ikke igjen
 * før noen trykker «Hent på nytt» i fanen.
 *
 * Fremgangsmåten er den samme som python-roborock (Home Assistant) bruker.
 */

// ROBOROCK_BASE_URL kan overstyres, for eksempel for å teste mot en falsk server.
const TEST_URL = process.env.ROBOROCK_BASE_URL?.trim() || "";
const BASE_URLS = TEST_URL ? [TEST_URL] : ["https://euiot.roborock.com", "https://usiot.roborock.com", "https://cniot.roborock.com", "https://ruiot.roborock.com"];
const trusted = (u: URL) => Boolean(TEST_URL) || (u.protocol === "https:" && (u.hostname === "roborock.com" || u.hostname.endsWith(".roborock.com")));
const storePath = path.join(dataDir, "roborock.json");
const POLL_MS = 15_000;
const POLL_ACTIVE_MS = 5_000;
const SLOW_MS = 30 * 60_000;

interface RRiot {
  u: string;
  s: string;
  h: string;
  k: string;
  r: { a: string };
}

interface StoredDevice {
  duid: string;
  name: string;
  localKey: string;
  model: string;
  productName: string;
  ip: string | null;
  /** Satt for hånd i fanen, og letes ikke etter på nytt. */
  manualIp?: boolean;
  version: Version | null;
}

interface Stored {
  email: string;
  baseUrl: string;
  country: string | null;
  countryCode: string | null;
  clientId: string;
  userData: { token: string; rriot: RRiot } | null;
  rooms: { id: string; name: string }[];
  devices: StoredDevice[];
  fetched: string | null;
}

export interface VacuumState {
  duid: string;
  name: string;
  model: string;
  ip: string | null;
  connected: boolean;
  problem: string;
  state: number | null;
  stateText: string;
  active: boolean;
  docked: boolean;
  battery: number | null;
  error: string;
  fan: number | null;
  water: number | null;
  cleanMinutes: number | null;
  cleanArea: number | null;
  rooms: { segment: number; name: string }[];
  /** Det dashbordet sist ba den om, så skjermen kan vise «Støvsug og vask · Stue og Kjøkken». */
  job: { mode: CleanMode; rooms: string[]; repeat: number; at: string } | null;
  /** Om den kan vaske (har mopp). Da vises «Hva?» og vann. */
  canMop: boolean;
  consumables: { key: string; name: string; percent: number; hoursLeft: number }[];
  totals: { hours: number; area: number; count: number } | null;
  updated: string | null;
}

export type CleanMode = "both" | "vac" | "mop";

export interface RoborockState {
  status: "login" | "code_sent" | "loading" | "ok" | "error";
  reason: string;
  email: string;
  vacuums: VacuumState[];
}

// Tilstandene fra get_status, på norsk. Samme tall som i python-roborock.
const STATES: Record<number, string> = {
  1: "Starter",
  2: "Ikke på laderen",
  3: "Venter",
  4: "Fjernstyres",
  5: "Støvsuger",
  6: "Kjører hjem",
  7: "Manuell",
  8: "Lader",
  9: "Problem med ladingen",
  10: "Pause",
  11: "Punktrengjøring",
  12: "Feil",
  13: "Slår seg av",
  14: "Oppdaterer",
  15: "Kjører inn i laderen",
  16: "Kjører til punkt",
  17: "Støvsuger sone",
  18: "Støvsuger rom",
  22: "Tømmer beholderen",
  28: "I samtale",
  30: "Overvåker",
  32: "Patruljerer",
  33: "Fester moppen",
  34: "Tar av moppen",
  101: "Frakoblet",
  103: "Låst",
  202: "Stopper tørkingen",
  6301: "Vasker gulvet",
  6302: "Støvsuger og vasker",
  6303: "Vasker gulvet",
  6304: "Vasker rom",
  6305: "Støvsuger og vasker rom",
  6306: "Vasker rom",
  6307: "Vasker sone",
  6308: "Støvsuger og vasker sone",
  6309: "Vasker sone",
  6310: "Kjører hjem for å vaske moppen",
  23: "Vasker moppen",
  25: "Vasker moppen",
  26: "Kjører for å vaske moppen",
  29: "Lager kart",
  100: "Ferdig ladet",
};
const ACTIVE = new Set([1, 4, 5, 6, 7, 11, 15, 16, 17, 18, 23, 25, 26, 29, 33, 34, 6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309, 6310]);
const DOCKED = new Set([8, 9, 22, 100, 202]);

const ERRORS: Record<number, string> = {
  1: "Lasertårnet er blokkert",
  2: "Støtfangeren sitter fast",
  3: "Hjulene henger i luften",
  4: "Kantsensoren er skitten",
  5: "Hovedbørsten sitter fast",
  6: "Sidebørsten sitter fast",
  7: "Hjulene sitter fast",
  8: "Står fast",
  9: "Støvbeholderen mangler",
  10: "Filteret er vått eller tett",
  11: "Sterkt magnetfelt",
  12: "Lavt batteri",
  13: "Ladefeil",
  14: "Batterifeil",
  15: "Veggsensoren er skitten",
  16: "Står skjevt",
  17: "Feil med sidebørsten",
  18: "Feil med viften",
  19: "Laderen har ikke strøm",
  20: "Den optiske sensoren er skitten",
  22: "Finner ikke laderen",
  23: "Kom seg ikke hjem til laderen",
  24: "Kom til en forbudt sone",
  25: "Kamerafeil",
  26: "Feil med veggsensoren",
  27: "Moppeløfteren sitter fast",
  29: "Filteret er tett",
  30: "Kom til en usynlig vegg",
  31: "Kommer seg ikke over teppet",
  32: "Intern feil",
  34: "Tømmestasjonen må rengjøres",
  38: "Sjekk rentvannstanken",
  39: "Sjekk skittenvannstanken",
  41: "Rentvannstanken er tom",
  53: "Vaskebrettet er fullt av vann",
  55: "Sjekk vaskebrettet",
};

const PARTS = [
  { key: "main_brush_work_time", name: "Hovedbørste", life: 300 },
  { key: "side_brush_work_time", name: "Sidebørste", life: 200 },
  { key: "filter_work_time", name: "Filter", life: 150 },
  { key: "sensor_dirty_time", name: "Sensorer", life: 30 },
];

/** Gyldige verdier for sugestyrke og vannmengde. 105 = av (bare mopp) finnes bare på noen modeller. */
export const FAN_MODES = [101, 102, 103, 104, 105, 106, 108, 110];
export const WATER_MODES = [200, 201, 202, 203, 204, 207];

class CloudError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

function cloudMessage(r: { code?: number; msg?: string } | null, fallback: string): CloudError {
  const code = r?.code;
  const known: Record<number, string> = {
    2008: "Fant ingen Roborock-konto med den e-posten.",
    3039: "Fant ingen Roborock-konto med den e-posten.",
    2018: "Koden stemmer ikke, eller den er for gammel. Be om en ny.",
    9002: "For mange koder på kort tid. Vent noen minutter og prøv igjen.",
    3009: "Godta brukervilkårene i Roborock-appen først, og prøv igjen.",
    3006: "Godta brukervilkårene i Roborock-appen på nytt. Er dette en Mi Home-konto, virker den ikke her.",
    2003: "E-postadressen ser ikke riktig ut.",
    2010: "Innloggingen har gått ut. Logg inn på nytt.",
  };
  return new CloudError((code !== undefined && known[code]) || `${r?.msg || fallback}${code !== undefined ? ` (kode ${code})` : ""}`, code);
}

function hawk(rriot: RRiot, urlPath: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(6).toString("base64url");
  const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
  const pre = [rriot.u, rriot.s, nonce, String(ts), md5(urlPath), "", ""].join(":");
  const mac = crypto.createHmac("sha256", rriot.h).update(pre).digest("base64");
  return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${ts}",nonce="${nonce}",mac="${mac}"`;
}

class Cloud {
  constructor(private readonly s: Stored) {}

  private clientHeader(): string {
    return crypto.createHash("md5").update(this.s.email).update(this.s.clientId).digest("base64");
  }

  async call(base: string, method: string, p: string, opts: { query?: Record<string, string>; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<any> {
    const url = new URL(base.replace(/\/+$/, "") + p);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { header_clientid: this.clientHeader(), Accept: "application/json", ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new CloudError(`Får ikke kontakt med Roborock (${url.host}): ${(err as Error).message}`);
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new CloudError(`Roborock svarte med noe uventet (HTTP ${res.status})`);
    }
  }

  /** Finner riktig region (Europa, USA osv.) for e-posten. */
  async region(): Promise<void> {
    let last: CloudError | null = null;
    for (const base of BASE_URLS) {
      const r = await this.call(base, "POST", "/api/v1/getUrlByEmail", { query: { email: this.s.email, needtwostepauth: "false" } }).catch((e) => {
        last = e;
        return null;
      });
      if (!r) continue;
      if (r.code !== 200 || !r.data?.url) {
        last = cloudMessage(r, "Fant ikke kontoen");
        if (r.code === 2003) break;
        continue;
      }
      if (r.data.country == null && r.data.countrycode == null) continue;
      const url = new URL(r.data.url);
      if (!trusted(url)) throw new CloudError(`Uventet adresse fra Roborock: ${url.host}`);
      this.s.baseUrl = url.origin;
      this.s.country = r.data.country ?? null;
      this.s.countryCode = r.data.countrycode != null ? String(r.data.countrycode) : null;
      return;
    }
    throw last ?? new CloudError("Fant ingen Roborock-konto med den e-posten.");
  }

  async sendCode(): Promise<void> {
    await this.region();
    if (this.s.country && this.s.countryCode) {
      const r = await this.call(this.s.baseUrl, "POST", "/api/v4/email/code/send", { form: { email: this.s.email, type: "login", platform: "" }, headers: { header_clientlang: "en" } });
      if (r.code === 200) return;
      if (r.code !== 3030) throw cloudMessage(r, "Klarte ikke å sende koden");
    }
    const r = await this.call(this.s.baseUrl, "POST", "/api/v1/sendEmailCode", { query: { username: this.s.email, type: "auth" } });
    if (r.code !== 200) throw cloudMessage(r, "Klarte ikke å sende koden");
  }

  async login(code: string): Promise<void> {
    if (!this.s.baseUrl) await this.region();
    let r: any = null;
    if (this.s.country && this.s.countryCode) {
      const ks = Array.from(crypto.randomBytes(16), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
      const signed = await this.call(this.s.baseUrl, "POST", "/api/v3/key/sign", { query: { s: ks } });
      if (signed.code !== 200 || !signed.data?.k) throw cloudMessage(signed, "Klarte ikke å logge inn");
      const agreement = await this.call(this.s.baseUrl, "GET", "/api/v3/app/agreement/latest", { query: { country: this.s.country }, headers: { header_clientlang: "en" } }).catch(() => null);
      const major = Number.isInteger(agreement?.data?.majorVersion) ? agreement.data.majorVersion : 14;
      const minor = Number.isInteger(agreement?.data?.minorVersion) ? agreement.data.minorVersion : 0;
      r = await this.call(this.s.baseUrl, "POST", "/api/v4/auth/email/login/code", {
        form: { country: this.s.country, countryCode: this.s.countryCode, email: this.s.email, code, majorVersion: String(major), minorVersion: String(minor) },
        headers: { header_clientlang: "en", header_appversion: "4.54.02", header_phonesystem: "iOS", header_phonemodel: "iPhone16,1", "x-mercy-ks": ks, "x-mercy-k": signed.data.k },
      });
      if (r.code !== 200 && [2018, 3006, 3009, 3039].includes(r.code)) throw cloudMessage(r, "Klarte ikke å logge inn");
    }
    if (!r || r.code !== 200) r = await this.call(this.s.baseUrl, "POST", "/api/v1/loginWithCode", { query: { username: this.s.email, verifycode: code, verifycodetype: "AUTH_EMAIL_CODE" } });
    if (r.code !== 200 || !r.data?.rriot?.r?.a) throw cloudMessage(r, "Klarte ikke å logge inn");
    this.s.userData = { token: r.data.token, rriot: r.data.rriot };
  }

  /** Henter støvsugerne (med lokal nøkkel) og rommene. Roborock tillater bare noen få slike kall i timen. */
  async home(): Promise<void> {
    const ud = this.s.userData;
    if (!ud) throw new CloudError("Ikke logget inn");
    const detail = await this.call(this.s.baseUrl, "GET", "/api/v1/getHomeDetail", { headers: { Authorization: ud.token } });
    if (detail.code !== 200 || detail.data?.rrHomeId === undefined) throw cloudMessage(detail, "Fant ikke hjemmet i Roborock-kontoen");
    const api = new URL(ud.rriot.r.a);
    if (!trusted(api)) throw new CloudError(`Uventet adresse fra Roborock: ${api.host}`);
    let result: any = null;
    for (const prefix of ["/v3", "/v2", ""]) {
      const p = `${prefix}/user/homes/${detail.data.rrHomeId}`;
      const r = await this.call(api.origin, "GET", p, { headers: { Authorization: hawk(ud.rriot, p) } });
      if (r?.success && r.result) {
        result = r.result;
        break;
      }
    }
    if (!result) throw new CloudError("Roborock ga ikke ut listen over støvsugere");
    const products = new Map<string, any>((result.products ?? []).map((p: any) => [String(p.id), p]));
    const old = new Map(this.s.devices.map((d) => [d.duid, d]));
    this.s.devices = [...(result.devices ?? []), ...(result.receivedDevices ?? [])]
      .filter((d: any) => d.duid && d.localKey)
      .map((d: any) => {
        const prod = products.get(String(d.productId)) ?? {};
        const prev = old.get(d.duid);
        const pv = d.pv === "L01" ? "L01" : d.pv === "1.0" ? "1.0" : null;
        return {
          duid: d.duid,
          name: d.name || prod.name || d.duid,
          localKey: d.localKey,
          model: prod.model || "",
          productName: prod.name || "",
          ip: prev && (prev.localKey === d.localKey || prev.manualIp) ? prev.ip : null,
          manualIp: prev?.manualIp,
          version: prev?.version ?? pv,
        };
      });
    this.s.rooms = (result.rooms ?? []).map((r: any) => ({ id: String(r.id), name: String(r.name ?? "") }));
    this.s.fetched = new Date().toISOString();
  }
}

/** get_room_mapping svarer enten [[16, "123", 14], …] eller, med ett rom, [16, "123"]. */
export function parseRoomMapping(raw: unknown): [number, string][] {
  if (!Array.isArray(raw)) return [];
  if (raw.length >= 2 && !Array.isArray(raw[0]) && Number.isFinite(Number(raw[0]))) return [[Number(raw[0]), String(raw[1])]];
  return raw.filter((m) => Array.isArray(m) && m.length >= 2 && Number.isFinite(Number(m[0]))).map((m) => [Number(m[0]), String(m[1])]);
}

/** Rommene på kartet som er i bruk, fra get_multi_maps_list: [{ map_info: [{ mapFlag, rooms: [{ id, iot_name_id, iot_name }] }] }]. */
export function parseMapRooms(raw: unknown, current: number | null): Map<number, [string, string]> {
  const out = new Map<number, [string, string]>();
  const root: any = Array.isArray(raw) ? raw[0] : raw;
  const maps: any[] = Array.isArray(root?.map_info) ? root.map_info : [];
  const flagOf = (m: any) => Number(m?.mapFlag ?? m?.map_flag);
  const chosen = maps.find((m) => current !== null && flagOf(m) === current) ?? (maps.length === 1 ? maps[0] : null);
  for (const r of Array.isArray(chosen?.rooms) ? chosen.rooms : []) {
    const id = Number(r?.id);
    if (!Number.isFinite(id)) continue;
    out.set(id, [r.iot_name_id != null ? String(r.iot_name_id) : "", typeof r.iot_name === "string" ? r.iot_name : ""]);
  }
  return out;
}

/** Én støvsuger: holder forbindelsen oppe og spør om status jevnlig. */
class Vacuum {
  conn: LocalConnection | null = null;
  state: VacuumState;
  private timer: NodeJS.Timeout | null = null;
  private slowAt = 0;
  private mapping: [number, string][] = [];
  /** Rom fra get_multi_maps_list: segment → [iot-id, navn]. Nyere modeller har navnene her. */
  private mapRooms = new Map<number, [string, string]>();
  private mapFlag: number | null = null;
  private dry = 0;
  private lastRoomLog = "";
  private failures = 0;
  private connecting = false;
  stopped = false;

  constructor(
    readonly dev: StoredDevice,
    private readonly roomNames: () => Map<string, string>,
    private readonly changed: () => void,
    private readonly lost: (v: Vacuum) => void,
  ) {
    this.state = {
      duid: dev.duid,
      name: dev.name,
      model: dev.productName || dev.model,
      ip: dev.ip,
      connected: false,
      problem: dev.ip ? "Kobler til …" : "Leter etter støvsugeren på nettet …",
      state: null,
      stateText: "",
      active: false,
      docked: false,
      battery: null,
      error: "",
      fan: null,
      water: null,
      cleanMinutes: null,
      cleanArea: null,
      rooms: [],
      job: null,
      canMop: false,
      consumables: [],
      totals: null,
      updated: null,
    };
  }

  set(patch: Partial<VacuumState>): void {
    Object.assign(this.state, patch);
    this.changed();
  }

  start(): void {
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(() => {}), ms);
    this.timer.unref?.();
  }

  private async ensureConnected(): Promise<LocalConnection> {
    if (this.conn?.ready) return this.conn;
    if (!this.dev.ip) throw new Error("Vet ikke IP-adressen ennå");
    if (this.connecting) throw new Error("Kobler til …");
    this.connecting = true;
    try {
      this.conn?.close();
      const conn = new LocalConnection(this.dev.ip, this.dev.localKey, (dps) => this.onPush(dps), () => {
        this.set({ connected: false, problem: "Mistet forbindelsen, kobler til igjen …" });
        this.schedule(2000);
      });
      this.dev.version = await conn.open(this.dev.version);
      this.conn = conn;
      this.slowAt = 0;
      return conn;
    } finally {
      this.connecting = false;
    }
  }

  private onPush(dps: Record<string, unknown>): void {
    const n = (k: string) => (dps[k] !== undefined ? Number(dps[k]) : undefined);
    const raw: Record<string, number> = {};
    if (n("121") !== undefined) raw.state = n("121")!;
    if (n("122") !== undefined) raw.battery = n("122")!;
    if (n("120") !== undefined) raw.error_code = n("120")!;
    if (n("123") !== undefined) raw.fan_power = n("123")!;
    if (n("124") !== undefined) raw.water_box_mode = n("124")!;
    if (Object.keys(raw).length) this.applyStatus(raw);
  }

  private applyStatus(s: Record<string, any>): void {
    const patch: Partial<VacuumState> = { updated: new Date().toISOString() };
    if (s.dry_status !== undefined) this.dry = Number(s.dry_status) || 0;
    if (s.map_status !== undefined && Number.isFinite(Number(s.map_status))) {
      const flag = Number(s.map_status) >> 2;
      this.mapFlag = flag === 63 ? null : flag;
    }
    if (s.battery !== undefined) patch.battery = Number(s.battery);
    const st = s.state !== undefined ? Number(s.state) : this.state.state;
    if (st !== null) {
      const battery = patch.battery ?? this.state.battery;
      patch.state = st;
      patch.active = ACTIVE.has(st);
      patch.docked = DOCKED.has(st);
      // Samme ord som Roborock-appen bruker der det finnes et bedre ord enn selve tilstanden.
      patch.stateText = patch.docked && this.dry === 1 ? "Tørker moppen" : (st === 8 && battery === 100) || st === 100 ? "Ferdig ladet" : (STATES[st] ?? `Tilstand ${st}`);
      // Når den er hjemme igjen og ferdig, glemmer vi jobben.
      if (this.state.job && patch.docked && !patch.active && st !== 22 && Date.now() - Date.parse(this.state.job.at) > 60_000) patch.job = null;
    }
    if (s.error_code !== undefined) patch.error = Number(s.error_code) ? (ERRORS[Number(s.error_code)] ?? `Feilkode ${s.error_code}`) : "";
    if (s.fan_power !== undefined) patch.fan = Number(s.fan_power);
    if (s.water_box_mode !== undefined) {
      patch.water = Number(s.water_box_mode);
      patch.canMop = true;
    }
    if (s.clean_time !== undefined) patch.cleanMinutes = Math.round(Number(s.clean_time) / 60);
    if (s.clean_area !== undefined) patch.cleanArea = Math.round(Number(s.clean_area) / 100_000) / 10;
    this.set(patch);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const conn = await this.ensureConnected();
      const status = await conn.request<any[]>("get_status");
      const row = Array.isArray(status) ? status[0] : status;
      if (row && typeof row === "object") this.applyStatus(row);
      this.failures = 0;
      if (!this.state.connected || this.state.problem) this.set({ connected: true, problem: "" });
      if (Date.now() >= this.slowAt) {
        this.slowAt = Date.now() + SLOW_MS;
        await this.refreshSlow(conn).catch(() => {});
      }
    } catch (err) {
      this.failures++;
      const msg = (err as Error).message;
      this.set({ connected: false, problem: this.dev.ip ? `Får ikke kontakt med ${this.dev.ip}: ${msg}` : "Fant ikke støvsugeren på nettet." });
      this.conn?.close();
      this.conn = null;
      // Etter noen bomskudd kan adressen ha endret seg. Da letes det på nytt.
      if (this.failures === 3 && !this.dev.manualIp) this.lost(this);
      this.schedule(Math.min(60_000 * Math.max(1, this.failures - 2), 5 * 60_000));
      return;
    }
    this.schedule(this.state.active ? POLL_ACTIVE_MS : POLL_MS);
  }

  private async refreshSlow(conn: LocalConnection): Promise<void> {
    await this.refreshRooms(conn);
    const cons = await conn.request<any>("get_consumable").catch(() => null);
    const c = Array.isArray(cons) ? cons[0] : cons;
    if (c && typeof c === "object") {
      this.state.consumables = PARTS.filter((p) => Number.isFinite(Number(c[p.key]))).map((p) => {
        const left = Math.max(0, p.life * 3600 - Number(c[p.key]));
        return { key: p.key, name: p.name, percent: Math.round((left / (p.life * 3600)) * 100), hoursLeft: Math.round(left / 3600) };
      });
    }
    const sum = await conn.request<any>("get_clean_summary").catch(() => null);
    if (sum) {
      const [t, a, n] = Array.isArray(sum) ? sum : [sum.clean_time, sum.clean_area, sum.clean_count];
      if (Number.isFinite(Number(t))) this.state.totals = { hours: Math.round(Number(t) / 3600), area: Math.round(Number(a) / 1_000_000), count: Number(n) || 0 };
    }
    this.changed();
  }

  /**
   * Rommene hentes to steder fra, slik python-roborock gjør: get_room_mapping (segment og rom-id)
   * og get_multi_maps_list (rommene på hvert kart, ofte med navn). Navnene fra Roborock-kontoen vinner.
   */
  private async refreshRooms(conn: LocalConnection): Promise<void> {
    const errText = (e: Error) => `feil: ${e.message}`;
    let mappingRaw: unknown = null;
    let mapsRaw: unknown = null;
    try {
      mappingRaw = await conn.request("get_room_mapping", [], 15_000);
      this.mapping = parseRoomMapping(mappingRaw);
    } catch (e) {
      mappingRaw = errText(e as Error);
    }
    try {
      mapsRaw = await conn.request("get_multi_maps_list", [], 15_000);
      this.mapRooms = parseMapRooms(mapsRaw, this.mapFlag);
    } catch (e) {
      mapsRaw = errText(e as Error);
    }
    this.updateRooms();
    // Skriv svarene i loggen når de endrer seg, så det er lett å se hva støvsugeren faktisk sier.
    const log = `rom ${JSON.stringify(mappingRaw)}; kart ${JSON.stringify(mapsRaw)}`.slice(0, 1500);
    if (log !== this.lastRoomLog) {
      this.lastRoomLog = log;
      console.log(`Roborock: ${this.dev.name}: ${this.state.rooms.length} rom (${this.state.rooms.map((r) => `${r.name}=${r.segment}`).join(", ") || "ingen"}). Svar fra støvsugeren: ${log}`);
    }
    // Fant vi ingen rom, prøver vi igjen om to minutter i stedet for en halvtime.
    if (!this.state.rooms.length) this.slowAt = Math.min(this.slowAt, Date.now() + 2 * 60_000);
  }

  updateRooms(): void {
    const names = this.roomNames();
    const segments = new Map<number, string>();
    for (const [seg, id] of this.mapping) segments.set(seg, id);
    for (const [seg, [id]] of this.mapRooms) if (!segments.has(seg) || !segments.get(seg)) segments.set(seg, id);
    this.state.rooms = [...segments]
      .map(([segment, id]) => ({ segment, name: names.get(id) || this.mapRooms.get(segment)?.[1] || `Rom ${segment}` }))
      .sort((a, b) => a.name.localeCompare(b.name, "nb"));
    this.changed();
  }

  setJob(job: VacuumState["job"]): void {
    this.set({ job });
  }

  setIp(ip: string | null, manual = false): void {
    this.dev.ip = ip;
    this.dev.manualIp = manual || undefined;
    this.failures = 0;
    this.conn?.close();
    this.conn = null;
    this.set({ ip, problem: ip ? "Kobler til …" : "Fant ikke støvsugeren på nettet." });
    if (ip) this.schedule(0);
  }

  async command(method: string, params: unknown = []): Promise<unknown> {
    const conn = await this.ensureConnected();
    const result = await conn.request(method, params);
    // Hent status litt etterpå, så knappene viser det nye med en gang.
    this.schedule(1200);
    return result;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.conn?.close();
  }
}

export class RoborockManager {
  private s: Stored;
  private vacuums = new Map<string, Vacuum>();
  private status: RoborockState["status"] = "login";
  private reason = "";
  private scanning = false;
  private scanAgainAt = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onChange: (state: RoborockState) => void,
    private readonly bridgeIp: string = "",
  ) {
    this.s = { email: process.env.ROBOROCK_EMAIL ?? "", baseUrl: "", country: null, countryCode: null, clientId: crypto.randomBytes(16).toString("base64url"), userData: null, rooms: [], devices: [], fetched: null };
  }

  get state(): RoborockState {
    return { status: this.status, reason: this.reason, email: this.s.email, vacuums: [...this.vacuums.values()].map((v) => v.state) };
  }

  private emit(): void {
    this.onChange(this.state);
  }

  private set(status: RoborockState["status"], reason = ""): void {
    this.status = status;
    this.reason = reason;
    this.emit();
  }

  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(storePath, "utf8")) as Partial<Stored>;
      this.s = { ...this.s, ...saved, email: saved.email || this.s.email };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("Roborock: klarte ikke å lese roborock.json:", (err as Error).message);
    }
    if (this.s.devices.length) {
      this.set("ok");
      this.startVacuums();
    } else if (this.s.userData) {
      await this.fetchHome();
    } else this.set("login");
  }

  private async save(): Promise<void> {
    const tmp = `${storePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.s, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, storePath);
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => console.error("Roborock: klarte ikke å lagre:", e.message));
    }, 2000);
  }

  async sendCode(email: string): Promise<void> {
    if (this.s.email !== email) {
      this.s = { ...this.s, email, baseUrl: "", country: null, countryCode: null, userData: null };
    }
    try {
      await new Cloud(this.s).sendCode();
      this.set("code_sent", `Koden er sendt til ${email}.`);
    } catch (err) {
      this.set("login", (err as Error).message);
      throw err;
    }
  }

  async login(code: string): Promise<void> {
    try {
      await new Cloud(this.s).login(code);
    } catch (err) {
      this.set("code_sent", (err as Error).message);
      throw err;
    }
    await this.save();
    await this.fetchHome();
  }

  /** Henter støvsugere, nøkler og rom fra skyen på nytt, og leter etter dem på nettet. */
  async fetchHome(): Promise<void> {
    this.set("loading", "Henter støvsugerne fra Roborock-kontoen …");
    try {
      await new Cloud(this.s).home();
    } catch (err) {
      const e = err as CloudError;
      if (e.code === 2010) {
        this.s.userData = null;
        this.set("login", e.message);
      } else this.set(this.s.devices.length ? "ok" : "error", e.message);
      await this.save().catch(() => {});
      if (this.s.devices.length) this.startVacuums();
      return;
    }
    await this.save();
    if (!this.s.devices.length) return this.set("error", "Fant ingen støvsugere i Roborock-kontoen.");
    this.set("ok");
    this.startVacuums(true);
    console.log(`Roborock: ${this.s.devices.map((d) => `${d.name} (${d.productName || d.model})`).join(", ")}`);
  }

  private startVacuums(restart = false): void {
    if (restart) {
      for (const v of this.vacuums.values()) v.stop();
      this.vacuums.clear();
    }
    const names = () => new Map(this.s.rooms.map((r) => [r.id, r.name]));
    for (const dev of this.s.devices) {
      if (this.vacuums.has(dev.duid)) continue;
      const v = new Vacuum(dev, names, () => {
        this.emit();
        this.saveSoon();
      }, () => this.scan(true));
      this.vacuums.set(dev.duid, v);
      if (dev.ip) v.start();
    }
    if (this.s.devices.some((d) => !d.ip)) this.scan();
  }

  /** Adressene som letes gjennom: samme /24 som Hue-broen, og resten av en /22 for TP-Link Deco (192.168.68–71). */
  private candidates(): string[] {
    const custom = process.env.ROBOROCK_SUBNET?.trim();
    const base = custom || this.bridgeIp.split(".").slice(0, 3).join(".");
    const m = base.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return [];
    const third = Number(m[3]);
    const thirds = [third];
    if (!custom) {
      const start = third - (third % 4);
      for (let t = start; t < start + 4; t++) if (t !== third) thirds.push(t);
    }
    return thirds.flatMap((t) => Array.from({ length: 254 }, (_, i) => `${m[1]}.${m[2]}.${t}.${i + 1}`));
  }

  private async scan(force = false): Promise<void> {
    if (this.scanning) return;
    if (!force && Date.now() < this.scanAgainAt) return;
    const missing = () => [...this.vacuums.values()].filter((v) => !v.conn?.ready && !v.dev.manualIp);
    if (!missing().length) return;
    this.scanning = true;
    this.scanAgainAt = Date.now() + 10 * 60_000;
    try {
      const hosts = await scanForVacuums(this.candidates());
      const known = new Set([...this.vacuums.values()].filter((v) => v.conn?.ready).map((v) => v.dev.ip));
      const placed = new Set<Vacuum>();
      for (const host of hosts.filter((h) => !known.has(h))) {
        for (const v of missing().filter((x) => !placed.has(x))) {
          // Den lokale nøkkelen avgjør hvem som svarer: bare riktig støvsuger forstår meldingen.
          const probe = new LocalConnection(host, v.dev.localKey);
          try {
            const version = await probe.open(v.dev.version, 3000);
            await probe.request("get_status", [], 3000);
            probe.close();
            v.dev.version = version;
            console.log(`Roborock: fant ${v.dev.name} på ${host}`);
            v.setIp(host);
            placed.add(v);
            break;
          } catch {
            probe.close();
          }
        }
      }
      for (const v of missing()) if (!placed.has(v) && (!v.dev.ip || !hosts.includes(v.dev.ip))) v.set({ problem: hosts.length ? "Fant ikke støvsugeren på nettet. Skriv inn IP-adressen under." : "Fant ingen Roborock-støvsugere på nettet. Skriv inn IP-adressen under." });
    } finally {
      this.scanning = false;
      this.saveSoon();
    }
  }

  async refresh(): Promise<void> {
    if (!this.s.userData) return this.set("login", "Logg inn først.");
    await this.fetchHome();
    await this.scan(true);
  }

  async logout(): Promise<void> {
    for (const v of this.vacuums.values()) v.stop();
    this.vacuums.clear();
    this.s = { ...this.s, userData: null, devices: [], rooms: [], fetched: null };
    await this.save();
    this.set("login");
  }

  setIp(duid: string, ip: string): void {
    const v = this.vacuums.get(duid);
    if (!v) throw new Error("Fant ikke støvsugeren");
    if (ip) v.setIp(ip, true);
    else {
      v.setIp(null);
      this.scan(true);
    }
    this.saveSoon();
  }

  async command(duid: string, body: Record<string, unknown>): Promise<void> {
    const v = this.vacuums.get(duid);
    if (!v) throw new Error("Fant ikke støvsugeren");
    const action = String(body.action ?? "");
    switch (action) {
      case "start":
        // Står den på pause, fortsetter den med det den holdt på med. Ellers tar den hele huset.
        await v.command("app_start");
        return;
      case "pause":
        await v.command("app_pause");
        return;
      case "stop":
        await v.command("app_stop");
        return;
      case "dock":
        await v.command("app_charge");
        return;
      case "find":
        await v.command("find_me");
        return;
      case "clean": {
        // Hele jobben på én gang: hva (støvsug/vask/begge), styrke, vann, rom og antall ganger.
        const mode: CleanMode = body.mode === "vac" || body.mode === "mop" ? body.mode : "both";
        const fan = Number(body.fan ?? 102);
        const water = Number(body.water ?? 202);
        if (![101, 102, 103, 104].includes(fan)) throw new Error("Ugyldig sugestyrke");
        if (![201, 202, 203].includes(water)) throw new Error("Ugyldig vannmengde");
        if (mode !== "both" && !v.state.canMop) throw new Error("Denne støvsugeren kan ikke vaske");
        const known = new Map(v.state.rooms.map((r) => [r.segment, r.name]));
        const segs = Array.isArray(body.segments) ? [...new Set(body.segments.map(Number))].filter((n) => known.has(n)) : [];
        const repeat = Math.min(2, Math.max(1, Math.round(Number(body.repeat) || 1)));
        // 105 = sug av (bare vask), 200 = vann av (bare støvsug).
        await v.command("set_custom_mode", [mode === "mop" ? 105 : fan]);
        if (v.state.canMop) await v.command("set_water_box_custom_mode", [mode === "vac" ? 200 : water]);
        // To ganger for hele huset går bare via rommene, så da tar vi alle rommene den kjenner.
        const targets = segs.length ? segs : repeat > 1 ? [...known.keys()] : [];
        if (targets.length) await v.command("app_segment_clean", [{ segments: targets, repeat }]);
        else await v.command("app_start");
        v.setJob({ mode, rooms: segs.map((s) => known.get(s)!), repeat: targets.length ? repeat : 1, at: new Date().toISOString() });
        return;
      }
      case "rooms": {
        const segs = Array.isArray(body.segments) ? body.segments.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [];
        if (!segs.length) throw new Error("Velg minst ett rom");
        const repeat = Math.min(3, Math.max(1, Math.round(Number(body.repeat) || 1)));
        await v.command("app_segment_clean", [{ segments: segs, repeat }]);
        return;
      }
      case "fan": {
        const value = Number(body.value);
        if (!FAN_MODES.includes(value)) throw new Error("Ugyldig sugestyrke");
        await v.command("set_custom_mode", [value]);
        v.set({ fan: value });
        return;
      }
      case "water": {
        const value = Number(body.value);
        if (!WATER_MODES.includes(value)) throw new Error("Ugyldig vannmengde");
        await v.command("set_water_box_custom_mode", [value]);
        v.set({ water: value });
        return;
      }
      default:
        throw new Error("Ukjent kommando");
    }
  }

  stop(): void {
    for (const v of this.vacuums.values()) v.stop();
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }
}
