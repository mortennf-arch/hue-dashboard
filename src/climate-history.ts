import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";

/**
 * Lagrer temperatur og fukt fra Verisure over tid, slik at dashbordet kan vise grafer.
 * Verisure gir bare siste måling, så historikken starter den dagen dette ble slått på.
 *
 * Hver måling er én linje i verisure-klima.jsonl: {"t":1730822400000,"id":"2BEQ CVUK","c":21.4,"h":41}
 */

const file = path.join(dataDir, "verisure-klima.jsonl");
const KEEP_MS = 400 * 24 * 3600_000;
/** Uten tidsstempel fra sensoren lagres høyst én måling per halvtime. */
const MIN_GAP_MS = 30 * 60_000;

export interface Reading {
  id: string;
  time: string | null;
  temperature: number | null;
  humidity: number | null;
}

interface Point {
  t: number;
  c: number | null;
  h: number | null;
}

export class ClimateHistory {
  private readonly series = new Map<string, Point[]>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      return;
    }
    const cutoff = Date.now() - KEEP_MS;
    let dropped = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const p = JSON.parse(line) as { t: number; id: string; c: number | null; h: number | null };
        if (typeof p.t !== "number" || typeof p.id !== "string") continue;
        if (p.t < cutoff) {
          dropped++;
          continue;
        }
        this.push(p.id, { t: p.t, c: p.c ?? null, h: p.h ?? null });
      } catch {
        dropped++;
      }
    }
    for (const list of this.series.values()) list.sort((a, b) => a.t - b.t);
    // Skriver filen på nytt uten gamle linjer, slik at den ikke vokser for alltid.
    if (dropped > 1000) await this.rewrite();
  }

  private push(id: string, p: Point): void {
    let list = this.series.get(id);
    if (!list) this.series.set(id, (list = []));
    list.push(p);
  }

  private async rewrite(): Promise<void> {
    const lines: string[] = [];
    for (const [id, list] of this.series) for (const p of list) lines.push(JSON.stringify({ t: p.t, id, c: p.c, h: p.h }));
    await writeFile(file, lines.join("\n") + (lines.length ? "\n" : ""));
  }

  /** Legger til nye målinger. En måling med samme tidsstempel som forrige hoppes over. */
  async record(readings: Reading[]): Promise<void> {
    await this.load();
    const now = Date.now();
    const out: string[] = [];
    for (const r of readings) {
      if (!r.id || (r.temperature == null && r.humidity == null)) continue;
      const parsed = r.time ? Date.parse(r.time) : NaN;
      const t = Number.isFinite(parsed) && parsed <= now + 60_000 ? parsed : now;
      const last = this.series.get(r.id)?.at(-1);
      if (last && (t <= last.t || (!Number.isFinite(parsed) && t - last.t < MIN_GAP_MS))) continue;
      const p = { t, c: r.temperature, h: r.humidity };
      this.push(r.id, p);
      out.push(JSON.stringify({ t, id: r.id, c: p.c, h: p.h }));
    }
    if (!out.length) return;
    await mkdir(dataDir, { recursive: true });
    await appendFile(file, out.join("\n") + "\n");
  }

  /** Første måling vi har, så dashbordet kan si hvor langt tilbake historikken går. */
  get since(): number | null {
    let min: number | null = null;
    for (const list of this.series.values()) if (list.length && (min === null || list[0].t < min)) min = list[0].t;
    return min;
  }

  /**
   * Målinger for de siste `hours` timene, slått sammen til høyst `maxPoints` punkter (gjennomsnitt per bøtte).
   * Uten id: alle sensorene.
   */
  query(hours: number, maxPoints: number, id?: string): Record<string, [number, number | null, number | null][]> {
    const to = Date.now();
    const from = to - hours * 3600_000;
    const bucket = Math.max(1, (to - from) / maxPoints);
    const result: Record<string, [number, number | null, number | null][]> = {};
    for (const [sid, list] of this.series) {
      if (id && sid !== id) continue;
      const buckets = new Map<number, { n: number; t: number; c: number; cn: number; h: number; hn: number }>();
      for (const p of list) {
        if (p.t < from) continue;
        const k = Math.floor((p.t - from) / bucket);
        const b = buckets.get(k) ?? { n: 0, t: 0, c: 0, cn: 0, h: 0, hn: 0 };
        b.n++;
        b.t += p.t;
        if (p.c != null) (b.c += p.c), b.cn++;
        if (p.h != null) (b.h += p.h), b.hn++;
        buckets.set(k, b);
      }
      result[sid] = [...buckets.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([, b]) => [Math.round(b.t / b.n), b.cn ? Math.round((b.c / b.cn) * 10) / 10 : null, b.hn ? Math.round(b.h / b.hn) : null]);
    }
    return result;
  }
}
