import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import type { HueClient } from "./hue-client.js";
import type { ResourceStore } from "./store.js";

/**
 * Timere som går på serveren, slik at de ringer selv om ingen skjerm er åpen og vises likt på
 * kjøkkennettbrettet og dashbordet. Når en timer er ferdig, ringer skjermene, og lyset i et valgt rom
 * eller en valgt sone blinker. Lyset blinker igjen hvert minutt til noen stopper timeren, men høyst i
 * RING_MAX_MS. Timerne lagres i data/timere.json, så de overlever en omstart.
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

export interface Timer {
  id: string;
  label: string;
  durationMs: number;
  endsAt: string;
  /** Rom eller sone som skal blinke, eller null. */
  room: string | null;
  roomName: string;
  ringing: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TimerManager {
  private timers: Timer[] = [];
  private readonly due = new Map<string, NodeJS.Timeout>();
  private readonly blinkers = new Map<string, NodeJS.Timeout>();
  private readonly blinking = new Set<string>();
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

  add(input: { seconds?: unknown; label?: unknown; room?: unknown }): Timer {
    const seconds = Math.round(Number(input.seconds));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > MAX_SECONDS) throw new Error("Velg en tid mellom 5 sekunder og 24 timer");
    if (this.timers.length >= MAX_TIMERS) throw new Error(`Det kan gå høyst ${MAX_TIMERS} timere samtidig`);
    let room: string | null = null;
    let roomName = "";
    if (input.room) {
      const r = this.store.get(String(input.room));
      if (!r || (r.type !== "room" && r.type !== "zone") || !this.groupOf(r.id)) throw new Error("Fant ikke rommet");
      room = r.id;
      roomName = r.metadata?.name ?? "";
    }
    const label = typeof input.label === "string" ? input.label.trim().slice(0, 40) : "";
    const t: Timer = { id: randomUUID(), label, durationMs: seconds * 1000, endsAt: new Date(Date.now() + seconds * 1000).toISOString(), room, roomName, ringing: false };
    this.timers.push(t);
    this.schedule(t);
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
    if (firstRing) console.log(`Timer: ${t.label || "uten navn"} er ferdig${t.roomName ? ` (blinker i ${t.roomName})` : ""}`);
    if (t.room) {
      void this.blink(t);
      this.blinkers.set(
        t.id,
        setInterval(() => void this.blink(t), BLINK_EVERY_MS),
      );
    }
    // Stopper av seg selv etter en stund, så lyset ikke blinker hele natta.
    const stopIn = Math.max(1000, Date.parse(t.endsAt) + RING_MAX_MS - Date.now());
    this.due.set(t.id, setTimeout(() => this.remove(t.id), stopIn));
    this.changed();
  }

  private quiet(t: Timer): void {
    clearInterval(this.blinkers.get(t.id));
    this.blinkers.delete(t.id);
    t.ringing = false;
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
