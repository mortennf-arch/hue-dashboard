import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import type { HueClient } from "./hue-client.js";
import type { ResourceStore } from "./store.js";

/**
 * Timere som går på serveren, slik at de ringer selv om ingen skjerm er åpen og vises likt på
 * kjøkkennettbrettet og dashbordet. Hver timer har sine egne varslingsvalg:
 * - lyd: skjermene piper (det gjør nettleseren, serveren sier bare at timeren ringer)
 * - blink: lyset i valgt rom eller sone slås av og på noen ganger, igjen hvert minutt
 * - rødt: lyset i rommet blir sterkt rødt til timeren stoppes, og settes så tilbake lampe for lampe
 * Ringingen stopper av seg selv etter RING_MAX_MS. Timerne lagres i data/timere.json.
 */

const CACHE = () => path.join(dataDir, "timere.json");
const MAX_TIMERS = 10;
const MAX_SECONDS = 24 * 3600;
/** Hvor lenge en ferdig timer ringer før den stopper av seg selv. */
const RING_MAX_MS = 10 * 60_000;
/** Lyset blinker på nytt så lenge timeren ringer. */
const BLINK_EVERY_MS = 60_000;
/** Broen tåler omtrent én kommando i sekundet per gruppe. */
const BLINK_STEP_MS = 1100;
const BLINK_TOGGLES = 6; // partall, så lyset ender slik det var

export interface TimerAlerts {
  sound: boolean;
  blink: boolean;
  red: boolean;
}

export interface Timer {
  id: string;
  label: string;
  durationMs: number;
  endsAt: string;
  /** Rom eller sone som skal blinke, eller null. */
  room: string | null;
  roomName: string;
  alerts: TimerAlerts;
  ringing: boolean;
}

/** Fargen «rød» i Hue sitt fargerom (xy). */
const RED = { x: 0.675, y: 0.322 };

interface SavedLight {
  id: string;
  on: boolean;
  brightness?: number;
  xy?: { x: number; y: number };
  mirek?: number;
}

function readAlerts(input: unknown, fallback: TimerAlerts): TimerAlerts {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (k: keyof TimerAlerts) => (typeof a[k] === "boolean" ? (a[k] as boolean) : fallback[k]);
  return { sound: pick("sound"), blink: pick("blink"), red: pick("red") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TimerManager {
  private timers: Timer[] = [];
  private readonly due = new Map<string, NodeJS.Timeout>();
  private readonly blinkers = new Map<string, NodeJS.Timeout>();
  private readonly blinking = new Set<string>();
  /** Lampene slik de var før de ble røde, per timer. */
  private readonly saved = new Map<string, SavedLight[]>();
  onChange: (timers: Timer[]) => void = () => {};

  constructor(
    private readonly client: HueClient,
    private readonly store: ResourceStore,
  ) {}

  list(): Timer[] {
    return [...this.timers].sort((a, b) => Number(b.ringing) - Number(a.ringing) || a.endsAt.localeCompare(b.endsAt));
  }

  /** Leser lagrede timere. En timer som gikk ut mens serveren var nede, ringer hvis det er under 10 minutter siden. */
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(CACHE(), "utf8")) as Timer[];
      if (!Array.isArray(saved)) return;
      const now = Date.now();
      this.timers = saved.filter((t) => t && typeof t.id === "string" && now - Date.parse(t.endsAt) < RING_MAX_MS);
      for (const t of this.timers) t.alerts = readAlerts(t.alerts, { sound: true, blink: Boolean(t.room), red: false });
      for (const t of this.timers) this.schedule(t);
    } catch {
      // ingen lagrede timere
    }
  }

  /** Rom og soner som kan blinke: de som har en lysgruppe. */
  private groupOf(room: string): string | null {
    const gl = this.store.all().find((r) => r.type === "grouped_light" && r.owner?.rid === room);
    return gl?.id ?? null;
  }

  private resolveRoom(input: unknown): { room: string | null; roomName: string } {
    if (!input) return { room: null, roomName: "" };
    const r = this.store.get(String(input));
    if (!r || (r.type !== "room" && r.type !== "zone") || !this.groupOf(r.id)) throw new Error("Fant ikke rommet");
    return { room: r.id, roomName: r.metadata?.name ?? "" };
  }

  add(input: { seconds?: unknown; label?: unknown; room?: unknown; alerts?: unknown }): Timer {
    const seconds = Math.round(Number(input.seconds));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > MAX_SECONDS) throw new Error("Velg en tid mellom 5 sekunder og 24 timer");
    if (this.timers.length >= MAX_TIMERS) throw new Error(`Det kan gå høyst ${MAX_TIMERS} timere samtidig`);
    const { room, roomName } = this.resolveRoom(input.room);
    const alerts = readAlerts(input.alerts, { sound: true, blink: Boolean(room), red: false });
    const label = typeof input.label === "string" ? input.label.trim().slice(0, 40) : "";
    const t: Timer = { id: randomUUID(), label, durationMs: seconds * 1000, endsAt: new Date(Date.now() + seconds * 1000).toISOString(), room, roomName, alerts, ringing: false };
    this.timers.push(t);
    this.schedule(t);
    this.changed();
    return t;
  }

  /** Endrer varslingsvalg, rom eller navn, også mens timeren går eller ringer. */
  update(id: string, input: { alerts?: unknown; room?: unknown; label?: unknown }): Timer {
    const t = this.timers.find((x) => x.id === id);
    if (!t) throw new Error("Fant ikke timeren");
    const before = { room: t.room, ...t.alerts };
    if ("room" in input) Object.assign(t, this.resolveRoom(input.room));
    if (input.alerts !== undefined) t.alerts = readAlerts(input.alerts, t.alerts);
    if (typeof input.label === "string") t.label = input.label.trim().slice(0, 40);
    // Ringer den, tas de nye valgene i bruk med en gang, uten å røre det som ikke er endret.
    if (t.ringing) {
      const roomChanged = before.room !== t.room;
      if (before.red && (!t.alerts.red || roomChanged)) void this.restoreRed(t).then(() => (t.ringing && t.alerts.red ? this.paintRed(t) : undefined));
      else if (!before.red && t.alerts.red) void this.paintRed(t);
      if (!t.alerts.blink || !t.room) {
        clearInterval(this.blinkers.get(t.id));
        this.blinkers.delete(t.id);
      } else if (!this.blinkers.has(t.id) || roomChanged) {
        clearInterval(this.blinkers.get(t.id));
        void this.blink(t);
        this.blinkers.set(t.id, setInterval(() => void this.blink(t), BLINK_EVERY_MS));
      }
    }
    this.changed();
    return t;
  }

  /** Legger til (eller trekker fra) tid. En timer som ringer, starter på nytt med den tiden. */
  extend(id: string, seconds: number): Timer {
    const t = this.timers.find((x) => x.id === id);
    if (!t) throw new Error("Fant ikke timeren");
    if (!Number.isFinite(seconds) || Math.abs(seconds) > MAX_SECONDS) throw new Error("Ugyldig tid");
    const base = t.ringing ? Date.now() : Date.parse(t.endsAt);
    const ends = Math.max(Date.now() + 5000, base + seconds * 1000);
    if (t.ringing) this.quiet(t);
    t.endsAt = new Date(ends).toISOString();
    t.durationMs = Math.max(t.durationMs, ends - Date.now());
    this.schedule(t);
    this.changed();
    return t;
  }

  /** Avbryter en timer som går, eller stopper en som ringer. */
  remove(id: string): boolean {
    const t = this.timers.find((x) => x.id === id);
    if (!t) return false;
    this.quiet(t);
    clearTimeout(this.due.get(id));
    this.due.delete(id);
    this.timers = this.timers.filter((x) => x.id !== id);
    this.changed();
    return true;
  }

  close(): void {
    for (const x of this.due.values()) clearTimeout(x);
    for (const x of this.blinkers.values()) clearInterval(x);
  }

  private schedule(t: Timer): void {
    clearTimeout(this.due.get(t.id));
    const left = Date.parse(t.endsAt) - Date.now();
    if (left <= 0) {
      this.ring(t);
      return;
    }
    // setTimeout tåler ikke mer enn ca. 24,8 døgn, og timerne er høyst ett døgn.
    this.due.set(t.id, setTimeout(() => this.ring(t), left));
  }

  private ring(t: Timer): void {
    this.due.delete(t.id);
    if (!this.timers.includes(t)) return;
    const firstRing = !t.ringing;
    t.ringing = true;
    if (firstRing) console.log(`Timer: ${t.label || "uten navn"} er ferdig${t.roomName && (t.alerts.blink || t.alerts.red) ? ` (lyset i ${t.roomName})` : ""}`);
    this.startAlerts(t);
    // Stopper av seg selv etter en stund, så lyset ikke blinker hele natta.
    const stopIn = Math.max(1000, Date.parse(t.endsAt) + RING_MAX_MS - Date.now());
    this.due.set(t.id, setTimeout(() => this.remove(t.id), stopIn));
    this.changed();
  }

  private startAlerts(t: Timer): void {
    t.ringing = true;
    if (!t.room) return;
    const blink = () => (t.alerts.blink ? this.blink(t) : Promise.resolve());
    // Rødt først, så blinkingen skjer i rødt.
    void (t.alerts.red ? this.paintRed(t) : Promise.resolve()).then(blink);
    if (t.alerts.blink) this.blinkers.set(t.id, setInterval(() => void blink(), BLINK_EVERY_MS));
  }

  private quiet(t: Timer): void {
    clearInterval(this.blinkers.get(t.id));
    this.blinkers.delete(t.id);
    t.ringing = false;
    void this.restoreRed(t);
  }

  /** Lampene i et rom (via enhetene) eller en sone (lampene direkte). */
  private lightsOf(roomId: string): string[] {
    const r = this.store.get(roomId) as { children?: { rid: string; rtype: string }[] } | undefined;
    const out: string[] = [];
    for (const c of r?.children ?? []) {
      if (c.rtype === "light") out.push(c.rid);
      else if (c.rtype === "device") {
        const dev = this.store.get(c.rid) as { services?: { rid: string; rtype: string }[] } | undefined;
        for (const s of dev?.services ?? []) if (s.rtype === "light") out.push(s.rid);
      }
    }
    return out;
  }

  private async paintRed(t: Timer): Promise<void> {
    if (!t.room || this.saved.has(t.id)) return;
    const gl = this.groupOf(t.room);
    if (!gl) return;
    const saved: SavedLight[] = [];
    for (const id of this.lightsOf(t.room)) {
      const l = this.store.get(id) as
        | { on?: { on?: boolean }; dimming?: { brightness?: number }; color?: { xy?: { x: number; y: number } }; color_temperature?: { mirek?: number | null; mirek_valid?: boolean } }
        | undefined;
      if (!l) continue;
      const s: SavedLight = { id, on: Boolean(l.on?.on), brightness: l.dimming?.brightness };
      if (l.color_temperature?.mirek_valid && l.color_temperature.mirek) s.mirek = l.color_temperature.mirek;
      else if (l.color?.xy) s.xy = l.color.xy;
      saved.push(s);
    }
    this.saved.set(t.id, saved);
    try {
      await this.client.put("grouped_light", gl, { on: { on: true }, dimming: { brightness: 100 }, color: { xy: RED } });
      await sleep(BLINK_STEP_MS);
    } catch (err) {
      console.error(`Timer: fikk ikke gjort lyset rødt i ${t.roomName}:`, (err as Error).message);
    }
  }

  /** Setter hver lampe tilbake slik den var. En lampe som var av, slås på i riktig farge og så av, ellers ville den husket rødt. */
  private async restoreRed(t: Timer): Promise<void> {
    const saved = this.saved.get(t.id);
    if (!saved) return;
    this.saved.delete(t.id);
    // Vent til en eventuell blinking er ferdig, så den ikke overstyrer.
    for (let i = 0; i < 20 && t.room && this.blinking.has(this.groupOf(t.room) ?? ""); i++) await sleep(300);
    const off: string[] = [];
    for (const s of saved) {
      const body: Record<string, unknown> = { on: { on: true } };
      if (s.brightness !== undefined) body.dimming = { brightness: Math.max(1, s.brightness) };
      if (s.mirek) body.color_temperature = { mirek: s.mirek };
      else if (s.xy) body.color = { xy: s.xy };
      await this.client.put("light", s.id, body).catch((err) => console.error("Timer: fikk ikke satt tilbake lampe:", (err as Error).message));
      if (!s.on) off.push(s.id);
      await sleep(120);
    }
    if (!off.length) return;
    await sleep(400);
    for (const id of off) {
      await this.client.put("light", id, { on: { on: false } }).catch(() => {});
      await sleep(120);
    }
  }

  /** Slår lysgruppen av og på noen ganger og lar den være slik den var. */
  private async blink(t: Timer): Promise<void> {
    if (!t.room) return;
    const gl = this.groupOf(t.room);
    if (!gl || this.blinking.has(gl)) return;
    this.blinking.add(gl);
    const original = Boolean((this.store.get(gl) as { on?: { on?: boolean } } | undefined)?.on?.on);
    let state = original;
    try {
      for (let i = 0; i < BLINK_TOGGLES; i++) {
        if (!t.ringing) break;
        state = !state;
        await this.client.put("grouped_light", gl, { on: { on: state } });
        await sleep(BLINK_STEP_MS);
      }
    } catch (err) {
      console.error(`Timer: fikk ikke blinket lyset i ${t.roomName}:`, (err as Error).message);
    } finally {
      // Ble timeren stoppet midt i, settes lyset tilbake med en gang.
      if (state !== original) await this.client.put("grouped_light", gl, { on: { on: original } }).catch(() => {});
      this.blinking.delete(gl);
    }
  }

  private changed(): void {
    this.onChange(this.list());
    writeFile(CACHE(), JSON.stringify(this.timers, null, 2)).catch(() => {});
  }
}
