import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { ClimateHistory } from "./climate-history.js";

/**
 * Leser alarmstatus, dører/vinduer, lås, temperatur/fukt og hendelsesloggen fra Verisure.
 *
 * Verisure har ikke noe offisielt API. Dette bruker det samme sky-API-et som appen deres, slik
 * biblioteket python-verisure (vsure) gjør det: innlogging på /auth/login og spørringer mot /graphql.
 * Har kontoen tofaktor, ber dashbordet om en engangskode én gang. Etterpå husker serveren enheten
 * («trust»-informasjonskapsel) i verisure.json i datasettet, så koden trengs ikke igjen.
 *
 * Satt opp med VERISURE_USERNAME og VERISURE_PASSWORD. Uten dem er delen skrudd av.
 */

// VERISURE_BASE_URLS kan overstyres, for eksempel for å teste mot en falsk server.
const BASE_URLS = (process.env.VERISURE_BASE_URLS ?? "https://automation01.verisure.com,https://automation02.verisure.com").split(",").map((u) => u.trim()).filter(Boolean);
const POLL_MS = Math.max(60, Number(process.env.VERISURE_POLL_S) || 300) * 1000;
const cookiePath = path.join(dataDir, "verisure.json");

export type VerisureStatus = "connecting" | "mfa_needed" | "mfa_sent" | "ok" | "error";

export interface VerisureState {
  status: VerisureStatus;
  reason: string;
  updated: string | null;
  installation: string;
  arm: { state: string; date: string | null; name: string; changedVia: string } | null;
  doors: { id: string; area: string; type: string; open: boolean; time: string | null }[];
  climate: { id: string; area: string; device: string; temperature: number | null; humidity: number | null; time: string | null }[];
  locks: { id: string; area: string; locked: boolean | null; door: string; method: string; user: string; time: string | null }[];
  plugs: { id: string; area: string; on: boolean }[];
  people: { name: string; home: boolean | null; location: string; time: string | null }[];
  events: { id: string; time: string; category: string; type: string; area: string; device: string; user: string; value: string }[];
}

class VerisureError extends Error {
  constructor(message: string, readonly kind: "auth" | "mfa" | "rate" | "other" = "other") {
    super(message);
  }
}

const Q = {
  installations: `query fetchAllInstallations($email: String!) { account(email: $email) { installations { giid alias } } }`,
  armState: `query ArmState($giid: String!) { installation(giid: $giid) { armState { type statusType date name changedVia } } }`,
  doorWindow: `query DoorWindow($giid: String!) { installation(giid: $giid) { doorWindows { device { deviceLabel area gui { label } } type area state wired reportTime } } }`,
  climate: `query Climate($giid: String!) { installation(giid: $giid) { climates { device { deviceLabel area gui { label } } humidityEnabled humidityTimestamp humidityValue temperatureTimestamp temperatureValue } } }`,
  smartLock: `query SmartLock($giid: String!) { installation(giid: $giid) { smartLocks { lockStatus doorState lockMethod eventTime device { deviceLabel area } user { name } } } }`,
  smartPlug: `query SmartPlug($giid: String!) { installation(giid: $giid) { smartplugs { device { deviceLabel area } currentState } } }`,
  users: `query userTrackings($giid: String!) { installation(giid: $giid) { userTrackings { name status currentLocationName currentLocationTimestamp } } }`,
  eventLog: `query EventLog($giid: String!, $offset: Int!, $pagesize: Int!, $eventCategories: [String], $fromDate: String, $toDate: String, $eventContactIds: [String], $eventDeviceLabels: [String]) { installation(giid: $giid) { eventLog(offset: $offset, pagesize: $pagesize, eventCategories: $eventCategories, eventContactIds: $eventContactIds, eventDeviceLabels: $eventDeviceLabels, fromDate: $fromDate, toDate: $toDate) { pagedList { device { deviceLabel area gui { label } } gatewayArea eventType eventCategory eventId eventTime userName armState climateValue sensorType } } } }`,
};

const EVENT_CATEGORIES = ["INTRUSION", "FIRE", "SOS", "WATER", "ANIMAL", "TECHNICAL", "WARNING", "ARM", "DISARM", "LOCK", "UNLOCK", "CLIMATE"];

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class VerisureClient {
  private cookies = new Map<string, string>();
  private giid = process.env.VERISURE_GIID ?? "";
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private polling = false;
  private backoffMs = 0;
  readonly history = new ClimateHistory();
  state: VerisureState = {
    status: "connecting",
    reason: "",
    updated: null,
    installation: "",
    arm: null,
    doors: [],
    climate: [],
    locks: [],
    plugs: [],
    people: [],
    events: [],
  };

  constructor(
    private readonly onChange: (state: VerisureState) => void,
    private readonly username = process.env.VERISURE_USERNAME ?? "",
    private readonly password = process.env.VERISURE_PASSWORD ?? "",
    private readonly appId = process.env.VERISURE_APP_ID ?? "PS_PYTHON",
  ) {}

  get configured(): boolean {
    return Boolean(this.username && this.password);
  }

  private set(patch: Partial<VerisureState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  // ---------- HTTP med informasjonskapsler ----------

  private cookieHeader(names?: (n: string) => boolean): string {
    return [...this.cookies]
      .filter(([n]) => !names || names(n))
      .map(([n, v]) => `${n}=${v}`)
      .join("; ");
  }

  private keepCookies(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "" || value === '""';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** Prøver automation01 og automation02, slik appen gjør, og flytter den som svarte først fremst. */
  private async call(
    method: string,
    url: string,
    opts: { basicAuth?: boolean; body?: unknown; cookies?: (n: string) => boolean } = {},
  ): Promise<{ status: number; text: string }> {
    let last: Error = new VerisureError("Fikk ikke svar fra Verisure");
    for (let i = 0; i < BASE_URLS.length; i++) {
      const base = BASE_URLS[0];
      try {
        const headers: Record<string, string> = { APPLICATION_ID: this.appId, Accept: "application/json" };
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
        if (opts.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
        const cookie = this.cookieHeader(opts.cookies);
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(base + url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        this.keepCookies(res);
        const lower = text.toLowerCase();
        if (res.status === 429 || /aut_00021|acc_00002|toomanystepuptokens|too many requests|rate limit|request limit/.test(lower)) {
          throw new VerisureError("Verisure sier at det har vært for mange forsøk. Venter litt.", "rate");
        }
        if (res.status >= 500 || text.includes("SYS_00004")) {
          last = new VerisureError(`Verisure svarte ${res.status}`);
          BASE_URLS.push(BASE_URLS.shift()!);
          continue;
        }
        return { status: res.status, text };
      } catch (err) {
        if (err instanceof VerisureError && err.kind === "rate") throw err;
        last = err instanceof Error ? err : new Error(String(err));
        BASE_URLS.push(BASE_URLS.shift()!);
      }
    }
    throw last;
  }

  private async saveCookies(): Promise<void> {
    const keep = Object.fromEntries([...this.cookies].filter(([n]) => /^(vid|vs-access|vs-refresh|vs-trust)/.test(n)));
    await mkdir(dataDir, { recursive: true });
    const tmp = `${cookiePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ username: this.username, giid: this.giid, cookies: keep }, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, cookiePath);
  }

  private async loadCookies(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(cookiePath, "utf8")) as { username?: string; giid?: string; cookies?: Record<string, string> };
      // Ny bruker i oppsettet: start på nytt.
      if (saved.username !== this.username) return;
      if (!process.env.VERISURE_GIID && saved.giid) this.giid = saved.giid;
      for (const [n, v] of Object.entries(saved.cookies ?? {})) if (typeof v === "string") this.cookies.set(n, v);
    } catch {
      // Ingen lagret innlogging ennå.
    }
  }

  // ---------- Innlogging ----------

  /** Logger inn med brukernavn og passord, og med «trust» fra en tidligere engangskode hvis vi har den. */
  private async login(): Promise<void> {
    const trust = [...this.cookies].filter(([n]) => n.startsWith("vs-trust"));
    this.cookies = new Map(trust);
    const res = await this.call("POST", "/auth/login", { basicAuth: true });
    if (res.status === 401 || res.status === 403) {
      throw new VerisureError("Verisure godtar ikke brukernavnet eller passordet. Sjekk VERISURE_USERNAME og VERISURE_PASSWORD.", "auth");
    }
    if (res.status >= 400) throw new VerisureError(`Innloggingen feilet (${res.status})`);
    if (res.text.includes("stepUpToken")) {
      throw new VerisureError("Verisure vil ha en engangskode. Trykk «Send kode» i Sikkerhet-fanen.", "mfa");
    }
    await this.saveCookies();
  }

  /** Henter en ny tilgangsnøkkel. Den varer omtrent 15 minutter. */
  private async refreshToken(): Promise<boolean> {
    if (!this.cookies.has("vs-refresh") && !this.cookies.has("vid")) return false;
    const res = await this.call("GET", "/auth/token", { cookies: (n) => n === "vid" || n === "vs-refresh" });
    if (res.status !== 200) return false;
    await this.saveCookies();
    return true;
  }

  /** Første steg for tofaktor: logg inn og be Verisure sende en kode på SMS (eller e-post). */
  async requestMfa(): Promise<void> {
    if (!this.configured) throw new Error("Verisure er ikke satt opp");
    this.cookies = new Map();
    const res = await this.call("POST", "/auth/login", { basicAuth: true });
    if (res.status === 401 || res.status === 403) throw new Error("Verisure godtar ikke brukernavnet eller passordet");
    if (!res.text.includes("stepUpToken")) {
      // Kontoen trenger ikke kode likevel. Bare hent data.
      await this.saveCookies();
      this.poll();
      return;
    }
    for (const type of ["phone", "email"]) {
      const r = await this.call("POST", `/auth/mfa?type=${type}`);
      if (r.status === 200) {
        this.set({ status: "mfa_sent", reason: type === "phone" ? "Koden er sendt på SMS." : "Koden er sendt på e-post." });
        return;
      }
    }
    throw new Error("Verisure ville ikke sende noen kode");
  }

  /** Andre steg: send inn koden, og be Verisure huske denne serveren så koden ikke trengs igjen. */
  async validateMfa(code: string): Promise<void> {
    const res = await this.call("POST", "/auth/mfa/validate", { body: { token: code } });
    if (res.status !== 200) throw new Error(res.status === 400 || res.status === 401 ? "Feil kode, eller koden er gått ut" : `Verisure svarte ${res.status}`);
    await this.call("POST", "/auth/trust");
    await this.saveCookies();
    this.backoffMs = 0;
    this.set({ status: "connecting", reason: "" });
    this.poll();
  }

  // ---------- Data ----------

  private async graphql(ops: { operationName: string; query: string; variables: Record<string, unknown> }[]): Promise<Record<string, any>[]> {
    const res = await this.call("POST", "/graphql", { body: ops });
    if (res.status === 401 || res.status === 403) throw new VerisureError("Innloggingen er gått ut", "auth");
    if (res.status !== 200) throw new VerisureError(`Verisure svarte ${res.status}`);
    const parsed = JSON.parse(res.text) as unknown;
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, any>[];
    const authErr = list.some((r) => (r.errors ?? []).some((e: any) => /auth|unauthor|token/i.test(`${e?.message} ${e?.data?.errorCode ?? ""}`)));
    if (authErr && list.every((r) => !r.data)) throw new VerisureError("Innloggingen er gått ut", "auth");
    return list;
  }

  private async chooseInstallation(): Promise<void> {
    const [res] = await this.graphql([{ operationName: "fetchAllInstallations", query: Q.installations, variables: { email: this.username } }]);
    const list = (res?.data?.account?.installations ?? []) as { giid: string; alias?: string }[];
    if (!list.length) throw new VerisureError("Fant ingen anlegg på Verisure-kontoen");
    const chosen = list.find((i) => i.giid === this.giid) ?? list[0];
    this.giid = chosen.giid;
    this.state.installation = chosen.alias ?? "";
    await this.saveCookies();
  }

  private async fetchAll(): Promise<void> {
    if (!this.giid || !this.state.installation) await this.chooseInstallation();
    const v = { giid: this.giid };
    const results = await this.graphql([
      { operationName: "ArmState", query: Q.armState, variables: v },
      { operationName: "DoorWindow", query: Q.doorWindow, variables: v },
      { operationName: "Climate", query: Q.climate, variables: v },
      { operationName: "SmartLock", query: Q.smartLock, variables: v },
      { operationName: "SmartPlug", query: Q.smartPlug, variables: v },
      { operationName: "userTrackings", query: Q.users, variables: v },
      {
        operationName: "EventLog",
        query: Q.eventLog,
        variables: { ...v, offset: 0, pagesize: 30, eventCategories: EVENT_CATEGORIES, eventContactIds: [], eventDeviceLabels: [], fromDate: null, toDate: null },
      },
    ]);
    const inst = (i: number) => (results[i]?.data?.installation ?? {}) as Record<string, any>;
    if (results.every((r) => !r?.data?.installation)) {
      const msg = results.flatMap((r) => r?.errors ?? []).map((e: any) => e?.message).find(Boolean);
      throw new VerisureError(msg ? `Verisure: ${msg}` : "Fikk ingen data fra Verisure");
    }

    const arm = inst(0).armState;
    const state: Partial<VerisureState> = {
      arm: arm ? { state: str(arm.statusType), date: arm.date ?? null, name: str(arm.name), changedVia: str(arm.changedVia) } : null,
      doors: (inst(1).doorWindows ?? []).map((d: any) => ({
        id: str(d.device?.deviceLabel),
        area: str(d.area) || str(d.device?.area),
        type: str(d.type),
        open: d.state === "OPEN",
        time: d.reportTime ?? null,
      })),
      climate: (inst(2).climates ?? []).map((c: any) => ({
        id: str(c.device?.deviceLabel),
        area: str(c.device?.area),
        device: str(c.device?.gui?.label),
        temperature: num(c.temperatureValue),
        humidity: c.humidityEnabled === false ? null : num(c.humidityValue),
        time: c.temperatureTimestamp ?? c.humidityTimestamp ?? null,
      })),
      locks: (inst(3).smartLocks ?? []).map((l: any) => ({
        id: str(l.device?.deviceLabel),
        area: str(l.device?.area),
        locked: l.lockStatus === "LOCKED" ? true : l.lockStatus === "UNLOCKED" ? false : null,
        door: str(l.doorState),
        method: str(l.lockMethod),
        user: str(l.user?.name),
        time: l.eventTime ?? null,
      })),
      plugs: (inst(4).smartplugs ?? []).map((p: any) => ({ id: str(p.device?.deviceLabel), area: str(p.device?.area), on: p.currentState === "ON" })),
      people: (inst(5).userTrackings ?? [])
        .filter((u: any) => u.status && u.status !== "DEACTIVATED")
        .map((u: any) => ({
          name: str(u.name),
          home: u.currentLocationName === "HOME" ? true : u.currentLocationName ? false : null,
          location: str(u.currentLocationName),
          time: u.currentLocationTimestamp ?? null,
        })),
      events: (inst(6).eventLog?.pagedList ?? []).map((e: any) => ({
        id: str(e.eventId),
        time: str(e.eventTime),
        category: str(e.eventCategory),
        type: str(e.eventType),
        area: str(e.device?.area) || str(e.gatewayArea),
        device: str(e.device?.gui?.label),
        user: str(e.userName),
        value: e.climateValue != null ? `${e.climateValue}${e.sensorType === "HUMIDITY" ? " %" : " °C"}` : "",
      })),
    };
    this.set({ ...state, status: "ok", reason: "", updated: new Date().toISOString() });
    this.history.record(state.climate ?? []).catch((err) => console.error("Verisure: klarte ikke å lagre målinger:", err.message));
  }

  /**
   * Feilsøking: finner ut hvilke spørringer Verisure har for historikk, siden appen viser grafer
   * men ingen har dokumentert hvordan. Returnerer bare skjemaet og statuskoder, aldri innlogging.
   */
  async probe(): Promise<Record<string, unknown>> {
    if (!(await this.refreshToken())) await this.login();
    if (!this.giid) await this.chooseInstallation();
    const out: Record<string, unknown> = {};
    const raw = async (name: string, query: string, variables: Record<string, unknown> = {}) => {
      try {
        const res = await this.call("POST", "/graphql", { body: [{ operationName: name, query, variables }] });
        // Skjemaet gjøres om til korte linjer som «climates(filter): [Climate]», så svaret blir lett å lese.
        const fields = (() => {
          try {
            const d = (JSON.parse(res.text) as any[])[0]?.data;
            const list = d?.__type?.fields ?? d?.__schema?.queryType?.fields;
            if (!Array.isArray(list)) return null;
            const typeName = (t: any): string => (!t ? "" : t.name ?? (t.kind === "LIST" ? `[${typeName(t.ofType)}]` : typeName(t.ofType)));
            return list.map((f: any) => `${f.name}(${(f.args ?? []).map((a: any) => a.name).join(", ")}): ${typeName(f.type)}`);
          } catch {
            return null;
          }
        })();
        out[name] = fields ? { status: res.status, fields } : { status: res.status, body: res.text.slice(0, 3000) };
      } catch (err) {
        out[name] = { error: (err as Error).message };
      }
    };
    const typeQuery = (t: string) =>
      `query T${t} { __type(name: "${t}") { name fields { name args { name type { name kind ofType { name kind } } } type { name kind ofType { name kind ofType { name } } } } } }`;
    await raw("TInstallation", typeQuery("Installation"));
    await raw("TClimate", typeQuery("Climate"));
    await raw("TQuery", `query TQuery { __schema { queryType { fields { name args { name } } } } }`);
    // Ukjente felter gir ofte «Did you mean ...?» i feilmeldingen, også når introspeksjon er av.
    const sensor = this.state.climate[0]?.id ?? "";
    for (const f of ["climateHistory", "climateValues", "climateGraph", "climateStatistics", "climateSeries", "history", "climateHistories"]) {
      await raw(`G_${f}`, `query G_${f}($giid: String!) { installation(giid: $giid) { ${f} } }`, { giid: this.giid });
    }
    await raw("G_climateArgs", `query G_climateArgs($giid: String!) { installation(giid: $giid) { climates(xyz: 1) { device { deviceLabel } } } }`, { giid: this.giid });
    // Det gamle REST-API-et hadde historikk per sensor.
    for (const url of [
      `/xbn/2/installation/${this.giid}/climate/simple/search?deviceLabel=${encodeURIComponent(sensor)}`,
      `/installation/${this.giid}/climate/simple/search?deviceLabel=${encodeURIComponent(sensor)}`,
    ]) {
      try {
        const res = await this.call("GET", url);
        out[`REST ${url.replace(this.giid, "GIID")}`] = { status: res.status, body: res.text.slice(0, 1500) };
      } catch (err) {
        out[`REST ${url.replace(this.giid, "GIID")}`] = { error: (err as Error).message };
      }
    }
    return out;
  }

  // ---------- Henting med jevne mellomrom ----------

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
  }

  /** Henter alt nå. Fornyer nøkkelen først, og logger inn på nytt hvis den ikke lar seg fornye. */
  poll(): void {
    if (this.polling || this.stopped) return;
    this.polling = true;
    (async () => {
      try {
        if (!(await this.refreshToken())) await this.login();
        try {
          await this.fetchAll();
        } catch (err) {
          if (!(err instanceof VerisureError && err.kind === "auth")) throw err;
          await this.login();
          await this.fetchAll();
        }
        this.backoffMs = 0;
        this.schedule(POLL_MS);
      } catch (err) {
        const e = err instanceof VerisureError ? err : new VerisureError((err as Error).message);
        if (e.kind === "mfa") {
          // Venter på at noen ber om kode i dashbordet. Prøver ikke selv, for å ikke sende SMS-er.
          if (this.state.status !== "mfa_sent") this.set({ status: "mfa_needed", reason: e.message });
          return;
        }
        if (e.kind === "auth") {
          // Feil passord: ikke prøv igjen før om en time, så kontoen ikke blir sperret.
          this.set({ status: "error", reason: e.message });
          this.schedule(60 * 60_000);
          return;
        }
        this.backoffMs = Math.min(60 * 60_000, Math.max(POLL_MS, this.backoffMs * 2 || POLL_MS));
        this.set({ status: this.state.updated ? this.state.status : "error", reason: e.message });
        console.error(`Verisure: ${e.message}. Prøver igjen om ${Math.round(this.backoffMs / 60_000)} min.`);
        this.schedule(this.backoffMs);
      } finally {
        this.polling = false;
      }
    })();
  }

  async start(): Promise<void> {
    if (!this.configured) return;
    await this.loadCookies();
    await this.history.load().catch((err) => console.error("Verisure: klarte ikke å lese historikken:", err.message));
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
