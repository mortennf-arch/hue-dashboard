import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

/**
 * Bilder til lysbildevisningen. Leser en mappe som er montert inn i containeren (standard /bilder),
 * med undermapper. Hver mappe rett under rotmappa blir et valg i fanen «Bilder». Bildene sendes som de er,
 * så nettleseren snur dem riktig selv ut fra EXIF.
 */

export interface Photo {
  id: string;
  folder: string;
  /** Hele mappestien under bildemappa, for eksempel «2011 · Påske». Tom for bilder rett i bildemappa. */
  album: string;
  /** Når bildet ble tatt (EXIF), ellers når filen sist ble endret. ISO-dato, YYYY-MM-DD. */
  date: string;
}

export interface PhotoSummary {
  configured: boolean;
  count: number;
  folders: { name: string; count: number }[];
  /** Bilder vi ikke kan vise i nettleseren, for eksempel HEIC fra iPhone. */
  skipped: number;
  scannedAt: string | null;
  problem: string;
}

const SHOW = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".avif", "image/avif"],
]);
const SKIP = new Set([".heic", ".heif", ".dng", ".cr2", ".nef", ".arw"]);
const RESCAN_MS = 30 * 60_000;
const MAX_PHOTOS = 50_000;

export class PhotoLibrary {
  private photos: Photo[] = [];
  private files = new Map<string, string>();
  private summary: PhotoSummary;
  private timer?: NodeJS.Timeout;
  private scanning: Promise<void> | null = null;

  constructor(readonly dir: string) {
    this.summary = { configured: false, count: 0, folders: [], skipped: 0, scannedAt: null, problem: "" };
  }

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => void this.scan(), RESCAN_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  get state(): PhotoSummary {
    return this.summary;
  }

  /** Bildene i en mappe (eller alle), eventuelt bare de som er tatt på denne datoen i tidligere år. */
  list(folder?: string, onThisDay?: string): Photo[] {
    let out = folder ? this.photos.filter((p) => p.folder === folder) : this.photos;
    if (onThisDay) {
      // Bare tidligere år: bilder uten EXIF får datoen filen ble kopiert, som ofte er i år.
      const year = String(new Date().getFullYear());
      out = out.filter((p) => p.date.slice(5) === onThisDay && p.date.slice(0, 4) !== year);
    }
    return out;
  }

  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    try {
      const st = await stat(this.dir).catch(() => null);
      if (!st?.isDirectory()) {
        this.summary = { ...this.summary, configured: false, problem: `Fant ikke mappen ${this.dir}` };
        return;
      }
      const photos: Photo[] = [];
      const files = new Map<string, string>();
      let skipped = 0;
      const walk = async (dir: string, folder: string, depth: number) => {
        if (depth > 8 || photos.length >= MAX_PHOTOS) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name.startsWith("@")) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full, folder || e.name, depth + 1);
            continue;
          }
          if (!e.isFile()) continue;
          const ext = path.extname(e.name).toLowerCase();
          if (SKIP.has(ext)) skipped++;
          if (!SHOW.has(ext) || photos.length >= MAX_PHOTOS) continue;
          const rel = path.relative(this.dir, full);
          const id = Buffer.from(rel).toString("base64url");
          const date = (ext === ".jpg" || ext === ".jpeg" ? await exifDate(full) : null) ?? (await stat(full)).mtime.toISOString().slice(0, 10);
          const album = path.dirname(rel) === "." ? "" : path.dirname(rel).split(path.sep).join(" · ");
          photos.push({ id, folder, album, date });
          files.set(id, full);
        }
      };
      await walk(this.dir, "", 0);
      photos.sort((a, b) => a.date.localeCompare(b.date));
      const counts = new Map<string, number>();
      for (const p of photos) if (p.folder) counts.set(p.folder, (counts.get(p.folder) ?? 0) + 1);
      const collator = new Intl.Collator("nb");
      this.photos = photos;
      this.files = files;
      this.summary = {
        configured: true,
        count: photos.length,
        folders: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => collator.compare(a.name, b.name)),
        skipped,
        scannedAt: new Date().toISOString(),
        problem: photos.length ? "" : `Fant ingen bilder i ${this.dir}`,
      };
      console.log(`Bilder: ${photos.length} bilder i ${counts.size} mapper${skipped ? `, ${skipped} hoppet over (HEIC/RAW)` : ""}`);
    } catch (err) {
      this.summary = { ...this.summary, problem: `Klarte ikke å lese bildene: ${(err as Error).message}` };
      console.error("Bilder:", (err as Error).message);
    }
  }

  /** Sender selve bildefilen. Bare filer som er funnet ved skanningen, kan hentes. */
  async serve(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const file = this.files.get(id);
    if (!file) return false;
    const st = await stat(file).catch(() => null);
    if (!st) return false;
    const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return true;
    }
    res.writeHead(200, {
      "Content-Type": SHOW.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "private, max-age=86400",
      ETag: etag,
    });
    createReadStream(file).pipe(res);
    return true;
  }
}

/** Leser DateTimeOriginal (eller DateTime) fra EXIF i starten av en JPEG. */
export async function exifDate(file: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(file, "r");
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseExifDate(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export function parseExifDate(buf: Buffer): string | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xe1 && buf.toString("latin1", pos + 4, pos + 10) === "Exif\0\0") {
      return tiffDate(buf.subarray(pos + 10, Math.min(buf.length, pos + 2 + len)));
    }
    if (marker === 0xda) return null;
    pos += 2 + len;
  }
  return null;
}

function tiffDate(t: Buffer): string | null {
  if (t.length < 8) return null;
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ascii = (entry: number) => {
    const count = u32(entry + 4);
    const off = count <= 4 ? entry + 8 : u32(entry + 8);
    return off + count <= t.length ? t.toString("latin1", off, off + count) : "";
  };
  const readIfd = (off: number) => {
    const tags = new Map<number, number>();
    if (off + 2 > t.length) return tags;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      tags.set(u16(e), e);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  let text = "";
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr !== undefined) {
    const exif = readIfd(u32(exifPtr + 8));
    const orig = exif.get(0x9003);
    if (orig !== undefined) text = ascii(orig);
  }
  if (!text && ifd0.has(0x0132)) text = ascii(ifd0.get(0x0132)!);
  const m = text.match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
