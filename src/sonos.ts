import dgram from "node:dgram";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";

/**
 * Snakker med Sonos-høyttalerne over hjemmenettet med deres lokale UPnP-API (port 1400). Ingen skykonto trengs.
 *
 * Det holder å kjenne én høyttaler: den forteller om alle de andre. Adressene vi har sett, lagres i
 * data/sonos.json, slik at appen finner dem igjen etter omstart selv om en av dem har fått ny adresse.
 * Tilstanden hentes ved jevnlig spørring, som virker i en vanlig Docker-container uten host-nettverk.
 */

export interface SonosPlayer {
  uuid: string;
  name: string;
  host: string;
  volume: number;
  muted: boolean;
}

export interface SonosTrack {
  title: string;
  artist: string;
  album: string;
  /** Full adresse til albumcover, eller tom. */
  art: string;
  /** Radiokanal eller spilleliste når det er det som spilles. */
  source: string;
  position: number;
  duration: number;
}

export interface SonosGroup {
  id: string;
  coordinator: string;
  /** Romnavnene i gruppen, koordinatoren først, f.eks. «Kjøkken + Stue». */
  name: string;
  members: SonosPlayer[];
  state: "playing" | "paused" | "stopped" | "transitioning";
  volume: number;
  muted: boolean;
  track: SonosTrack | null;
}

/** En Sonos-favoritt slik dashbordet ser den. Adressen og metadata blir på serveren. */
export interface SonosFavorite {
  id: string;
  title: string;
  /** Full adresse til bilde, eller tom. */
  art: string;
  /** F.eks. «Spilleliste», «Radio», «Album». */
  kind: string;
}

interface FavoriteItem extends SonosFavorite {
  uri: string;
  meta: string;
}

export interface SonosState {
  /** false når ingen høyttalere er funnet ennå. */
  available: boolean;
  reason: string;
  groups: SonosGroup[];
  favorites: SonosFavorite[];
  /** Spotify-kontoene Sonos kjenner, funnet ut fra favorittene. Tom når det ikke er noen. */
  spotifyAccounts: { sn: string; name: string; example: string }[];
  updatedAt: string;
}

const PORT = 1400;
const POLL_MS = 2000;
const TOPOLOGY_MS = 10_000;
const FAVORITES_MS = 60_000;
const TIMEOUT_MS = 4000;

const SERVICES = {
  AVTransport: { path: "/MediaRenderer/AVTransport/Control", urn: "urn:schemas-upnp-org:service:AVTransport:1" },
  RenderingControl: {
    path: "/MediaRenderer/RenderingControl/Control",
    urn: "urn:schemas-upnp-org:service:RenderingControl:1",
  },
  GroupRenderingControl: {
    path: "/MediaRenderer/GroupRenderingControl/Control",
    urn: "urn:schemas-upnp-org:service:GroupRenderingControl:1",
  },
  ZoneGroupTopology: { path: "/ZoneGroupTopology/Control", urn: "urn:schemas-upnp-org:service:ZoneGroupTopology:1" },
  ContentDirectory: { path: "/MediaServer/ContentDirectory/Control", urn: "urn:schemas-upnp-org:service:ContentDirectory:1" },
} as const;
type Service = keyof typeof SERVICES;

// ---------- Små XML-hjelpere. Svarene fra Sonos er faste og enkle, så vi trenger ingen full parser. ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${Object.entries(ENTITIES).find(([, v]) => v === c)![0]};`);
}

/** Teksten i første element med dette navnet, med eller uten navnerom-prefiks. */
export function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  return m ? unescapeXml(m[1]) : "";
}

function attrs(el: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of el.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

export interface TopologyGroup {
  id: string;
  coordinator: string;
  members: { uuid: string; name: string; host: string }[];
}

/** Leser ZoneGroupState. Skjulte enheter (surround, sub, den andre i et stereopar) tas ikke med. */
export function parseTopology(zoneGroupState: string): TopologyGroup[] {
  const groups: TopologyGroup[] = [];
  for (const g of zoneGroupState.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const ga = attrs(g[1]);
    const members: TopologyGroup["members"] = [];
    for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (a.Invisible === "1" || !a.UUID || !a.Location) continue;
      let host = "";
      try {
        host = new URL(a.Location).hostname;
      } catch {
        continue;
      }
      members.push({ uuid: a.UUID, name: a.ZoneName || "Sonos", host });
    }
    if (!members.length || !ga.Coordinator) continue;
    members.sort((x, y) => Number(y.uuid === ga.Coordinator) - Number(x.uuid === ga.Coordinator) || x.name.localeCompare(y.name, "nb"));
    groups.push({ id: ga.ID ?? ga.Coordinator, coordinator: ga.Coordinator, members });
  }
  return groups;
}

/** "0:03:21" -> 201 sekunder. */
export function parseDuration(s: string): number {
  const parts = s.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** Gjør albumcover-adressen om til en full adresse. Sonos gir ofte bare en sti på høyttaleren. */
function artUrl(raw: string, host: string): string {
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${host}:${PORT}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

/** Leser sporinfo fra DIDL-Lite-metadata. Radio har ofte «Artist - Tittel» i streamContent. */
export function parseTrack(meta: string, mediaMeta: string, host: string, rel: string, dur: string): SonosTrack | null {
  if (!meta || meta === "NOT_IMPLEMENTED") {
    const station = tag(mediaMeta, "title");
    return station ? { title: station, artist: "", album: "", art: "", source: station, position: 0, duration: 0 } : null;
  }
  let title = tag(meta, "title");
  let artist = tag(meta, "creator") || tag(meta, "albumArtist");
  const stream = tag(meta, "streamContent");
  const source = tag(mediaMeta, "title");
  if (stream && !stream.startsWith("x-sonos")) {
    const i = stream.indexOf(" - ");
    if (i > 0) {
      artist = stream.slice(0, i);
      title = stream.slice(i + 3);
    } else title = stream;
  }
  // Uten tittel er det som regel bare adressen til en strøm.
  if (!title || /^x-|^http/.test(title)) title = source || "Ukjent";
  return {
    title,
    artist,
    album: tag(meta, "album"),
    art: artUrl(tag(meta, "albumArtURI"), host),
    source: source && source !== title ? source : "",
    position: parseDuration(rel),
    duration: parseDuration(dur),
  };
}

/** Hva slags favoritt det er, ut fra adressen og klassen. */
function favoriteKind(uri: string, upnpClass: string, meta: string): string {
  const cls = `${upnpClass} ${tag(meta, "class")}`;
  if (/^x-sonosapi-(stream|radio|hls)|^x-rincon-mp3radio|^aac:|^hls-radio/.test(uri) || /audioBroadcast/.test(cls)) return "Radio";
  if (/playlist/i.test(cls) || /playlist/i.test(uri)) return "Spilleliste";
  if (/musicAlbum/.test(cls) || /album/i.test(uri)) return "Album";
  if (/musicArtist|person/.test(cls)) return "Artist";
  if (/audioItem|musicTrack/.test(cls)) return "Låt";
  return "Favoritt";
}

/** Leser favorittlisten (FV:2) fra ContentDirectory. */
export function parseFavorites(didl: string, host: string): FavoriteItem[] {
  const out: FavoriteItem[] = [];
  for (const m of didl.matchAll(/<item\s([^>]*)>([\s\S]*?)<\/item>/g)) {
    const id = attrs(m[1]).id;
    const body = m[2];
    const uri = tag(body, "res");
    const title = tag(body, "title");
    if (!id || !uri || !title) continue;
    const meta = tag(body, "resMD");
    out.push({
      id,
      title,
      art: artUrl(tag(body, "albumArtURI") || tag(meta, "albumArtURI"), host),
      kind: favoriteKind(uri, tag(body, "class"), meta),
      uri,
      meta,
    });
  }
  return out;
}

/** Strømmer (radio o.l.) spilles direkte. Alt annet legges i køen først, slik Sonos-appen gjør. */
export function playsDirect(uri: string): boolean {
  return /^x-sonosapi-(stream|radio|hls|hls-static)|^x-rincon-mp3radio|^aac:|^hls-radio|^x-sonos-htastream/.test(uri);
}

export interface SpotifyAccount {
  sid: string;
  sn: string;
  /** Kontoens nøkkel i Sonos, f.eks. SA_RINCON3079_X_#Svc3079-0-Token. */
  desc: string;
}

/**
 * Finner Spotify-kontoene Sonos bruker, ut fra Spotify-favorittene. Hver konto har sitt eget «sn»
 * (kontonummer i Sonos), så to personer med hver sin Spotify-konto gir to treff.
 */
export function spotifyAccountsFrom(favs: { uri: string; meta: string; title?: string }[]): (SpotifyAccount & { example: string })[] {
  const out = new Map<string, SpotifyAccount & { example: string }>();
  for (const f of favs) {
    if (!/spotify/i.test(f.uri)) continue;
    const sid = f.uri.match(/[?&]sid=(\d+)/)?.[1];
    const sn = f.uri.match(/[?&]sn=(\d+)/)?.[1];
    if (!sid || !sn || out.has(sn)) continue;
    const desc = tag(f.meta, "desc") || `SA_RINCON${Number(sid) * 256 + 7}_X_#Svc${Number(sid) * 256 + 7}-0-Token`;
    out.set(sn, { sid, sn, desc, example: f.title ?? "" });
  }
  return [...out.values()].sort((a, b) => Number(a.sn) - Number(b.sn));
}

export function spotifyAccountFrom(favs: { uri: string; meta: string }[]): SpotifyAccount | null {
  return spotifyAccountsFrom(favs)[0] ?? null;
}

/** Bygger Sonos-adresse og metadata for noe fra Spotify, slik Sonos-appen gjør. */
export function spotifyItem(type: "track" | "album" | "playlist" | "artist", id: string, title: string, acc: SpotifyAccount) {
  const kinds = {
    track: { prefix: "00032020", key: "track", cls: "object.item.audioItem.musicTrack" },
    album: { prefix: "1004206c", key: "album", cls: "object.container.album.musicAlbum" },
    playlist: { prefix: "1006206c", key: "playlist", cls: "object.container.playlistContainer" },
    artist: { prefix: "100c206c", key: "artistRadio", cls: "object.item.audioItem.audioBroadcast.#artistRadio" },
  } as const;
  const k = kinds[type];
  const enc = `spotify%3a${k.key}%3a${id}`;
  const q = `sid=${acc.sid}&flags=${type === "track" ? 8224 : 8300}&sn=${acc.sn}`;
  const uri =
    type === "track" ? `x-sonos-spotify:${enc}?${q}` : type === "artist" ? `x-sonosapi-radio:${enc}?${q}` : `x-rincon-cpcontainer:${k.prefix}${enc}?${q}`;
  const meta =
    `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
    `xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">` +
    `<item id="${k.prefix}${enc}" parentID="" restricted="true"><dc:title>${escapeXml(title)}</dc:title>` +
    `<upnp:class>${k.cls}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${escapeXml(acc.desc)}</desc>` +
    `</item></DIDL-Lite>`;
  return { uri, meta };
}

// ---------- Kommunikasjon ----------

async function soap(host: string, service: Service, action: string, args: Record<string, string | number> = {}): Promise<string> {
  const s = SERVICES[service];
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${s.urn}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
      .join("") +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(`http://${host}:${PORT}${s.path}`, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${s.urn}#${action}"` },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = tag(text, "errorCode");
    throw new Error(`Sonos ${host} svarte ${res.status} på ${action}${code ? ` (feilkode ${code})` : ""}`);
  }
  return text;
}

/** Leter etter Sonos-høyttalere med SSDP. Virker bare når containeren har host-nettverk. */
export function discover(timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        // Allerede lukket.
      }
      resolve([...found]);
    };
    socket.on("error", done);
    socket.on("message", (msg, rinfo) => {
      const text = msg.toString();
      if (/Sonos|ZonePlayer/i.test(text)) found.add(rinfo.address);
    });
    const search = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n",
    );
    socket.bind(() => {
      for (let i = 0; i < 2; i++) socket.send(search, 1900, "239.255.255.250", () => {});
    });
    setTimeout(done, timeoutMs);
  });
}

const TRANSPORT: Record<string, SonosGroup["state"]> = {
  PLAYING: "playing",
  PAUSED_PLAYBACK: "paused",
  STOPPED: "stopped",
  TRANSITIONING: "transitioning",
};

export class SonosManager {
  private seeds: string[];
  private known = new Set<string>();
  private topology: TopologyGroup[] = [];
  private topologyAt = 0;
  private state: SonosState = { available: false, reason: "Leter etter Sonos-høyttalere …", groups: [], favorites: [], spotifyAccounts: [], updatedAt: "" };
  private favorites: FavoriteItem[] = [];
  private favoritesAt = 0;
  private accountNames: Record<string, string> = {};
  private lastJson = "";
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private readonly cachePath = path.join(dataDir, "sonos.json");

  constructor(
    private readonly onChange: (state: SonosState) => void,
    seeds: string[] = (process.env.SONOS_IP ?? "").split(/[\s,]+/).filter(Boolean),
  ) {
    this.seeds = seeds;
  }

  get current(): SonosState {
    return this.state;
  }

  async start(): Promise<void> {
    try {
      const cached = JSON.parse(await readFile(this.cachePath, "utf8")) as { hosts?: string[]; spotifyNames?: Record<string, unknown> };
      for (const h of cached.hosts ?? []) if (typeof h === "string") this.known.add(h);
      for (const [sn, name] of Object.entries(cached.spotifyNames ?? {})) if (typeof name === "string") this.accountNames[sn] = name;
    } catch {
      // Ingen lagrede adresser ennå.
    }
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Spør høyttalerne på nytt med en gang, f.eks. rett etter en kommando. */
  refreshSoon(delayMs = 300): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.polling) return this.schedule(POLL_MS);
    this.polling = true;
    let next = POLL_MS;
    try {
      if (!this.topology.length || Date.now() - this.topologyAt > TOPOLOGY_MS) await this.loadTopology();
      if (!this.topology.length) {
        next = 30_000;
      } else {
        const results = await Promise.allSettled(this.topology.map((g) => this.readGroup(g)));
        const groups = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        // En høyttaler som ikke svarer, kan være slått av eller ha byttet adresse: hent oversikten på nytt neste gang.
        if (groups.length < results.length) this.topologyAt = 0;
        if (!groups.length) throw (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
        if (Date.now() - this.favoritesAt > FAVORITES_MS) await this.loadFavorites().catch(() => {});
        this.setState({
          available: true,
          reason: "",
          groups: groups.sort((a, b) => a.name.localeCompare(b.name, "nb")),
          favorites: this.favorites.map(({ id, title, art, kind }) => ({ id, title, art, kind })),
          spotifyAccounts: this.publicAccounts(),
          updatedAt: "",
        });
      }
    } catch (err) {
      this.topologyAt = 0;
      this.setState({ ...this.state, reason: (err as Error).message });
      next = 5000;
    } finally {
      this.polling = false;
      this.schedule(next);
    }
  }

  private setState(s: SonosState): void {
    const json = JSON.stringify({ ...s, updatedAt: "" });
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.state = { ...s, updatedAt: new Date().toISOString() };
    this.onChange(this.state);
  }

  private async loadTopology(): Promise<void> {
    const candidates = [...new Set([...this.seeds, ...this.known])];
    if (!candidates.length) candidates.push(...(await discover()));
    if (!candidates.length) {
      this.topology = [];
      this.setState({
        available: false,
        reason: "Fant ingen Sonos-høyttalere. Sett SONOS_IP til adressen til én av dem.",
        groups: [],
        favorites: [],
        spotifyAccounts: [],
        updatedAt: "",
      });
      return;
    }
    let lastErr: Error | null = null;
    for (const host of candidates) {
      try {
        const xml = await soap(host, "ZoneGroupTopology", "GetZoneGroupState");
        const groups = parseTopology(tag(xml, "ZoneGroupState"));
        if (!groups.length) continue;
        this.topology = groups;
        this.topologyAt = Date.now();
        const hosts = groups.flatMap((g) => g.members.map((m) => m.host));
        const before = [...this.known].sort().join();
        this.known = new Set(hosts);
        if ([...this.known].sort().join() !== before) this.saveHosts().catch(() => {});
        return;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    // Ingen av de kjente svarte. Prøv å lete på nettet før vi gir opp denne runden.
    const found = (await discover()).filter((h) => !candidates.includes(h));
    if (found.length) {
      for (const h of found) this.known.add(h);
      return this.loadTopology();
    }
    this.topology = [];
    throw new Error(`Får ikke kontakt med Sonos på ${candidates.join(", ")}${lastErr ? `: ${lastErr.message}` : ""}`);
  }

  /** Favorittene er felles for hele systemet, så det holder å spørre én høyttaler. */
  private async loadFavorites(): Promise<void> {
    const host = this.topology[0]?.members[0]?.host;
    if (!host) return;
    this.favoritesAt = Date.now();
    const xml = await soap(host, "ContentDirectory", "Browse", {
      ObjectID: "FV:2",
      BrowseFlag: "BrowseDirectChildren",
      Filter: "dc:title,res,upnp:albumArtURI,upnp:class,r:resMD",
      StartingIndex: 0,
      RequestedCount: 200,
      SortCriteria: "",
    });
    this.favorites = parseFavorites(tag(xml, "Result"), host);
  }

  private async saveHosts(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const data = { hosts: [...this.known], spotifyNames: this.accountNames };
    await writeFile(this.cachePath, JSON.stringify(data, null, 2) + "\n");
  }

  private publicAccounts(): SonosState["spotifyAccounts"] {
    return spotifyAccountsFrom(this.favorites).map((a, i) => ({
      sn: a.sn,
      name: this.accountNames[a.sn] || `Konto ${i + 1}`,
      example: a.example,
    }));
  }

  hasSpotifyAccount(sn: string): boolean {
    return spotifyAccountsFrom(this.favorites).some((a) => a.sn === sn);
  }

  /** Gir en Spotify-konto et navn som vises i dashbordet, f.eks. «Morten». Lagres i sonos.json. */
  async nameSpotifyAccount(sn: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 40);
    if (clean) this.accountNames[sn] = clean;
    else delete this.accountNames[sn];
    await this.saveHosts();
    this.setState({ ...this.state, spotifyAccounts: this.publicAccounts() });
  }

  private async readGroup(g: TopologyGroup): Promise<SonosGroup> {
    const coord = g.members.find((m) => m.uuid === g.coordinator) ?? g.members[0];
    const [transport, position, media, groupVol, members] = await Promise.all([
      soap(coord.host, "AVTransport", "GetTransportInfo", { InstanceID: 0 }),
      soap(coord.host, "AVTransport", "GetPositionInfo", { InstanceID: 0 }),
      soap(coord.host, "AVTransport", "GetMediaInfo", { InstanceID: 0 }),
      g.members.length > 1
        ? Promise.all([
            soap(coord.host, "GroupRenderingControl", "GetGroupVolume", { InstanceID: 0 }),
            soap(coord.host, "GroupRenderingControl", "GetGroupMute", { InstanceID: 0 }),
          ])
        : null,
      Promise.all(
        g.members.map(async (m): Promise<SonosPlayer> => {
          const [v, mu] = await Promise.all([
            soap(m.host, "RenderingControl", "GetVolume", { InstanceID: 0, Channel: "Master" }),
            soap(m.host, "RenderingControl", "GetMute", { InstanceID: 0, Channel: "Master" }),
          ]);
          return { ...m, volume: Number(tag(v, "CurrentVolume")) || 0, muted: tag(mu, "CurrentMute") === "1" };
        }),
      ),
    ]);
    const state = TRANSPORT[tag(transport, "CurrentTransportState")] ?? "stopped";
    const track = parseTrack(
      tag(position, "TrackMetaData"),
      tag(media, "CurrentURIMetaData"),
      coord.host,
      tag(position, "RelTime"),
      tag(position, "TrackDuration"),
    );
    const volume = groupVol ? Number(tag(groupVol[0], "CurrentVolume")) || 0 : members[0].volume;
    const muted = groupVol ? tag(groupVol[1], "CurrentMute") === "1" : members[0].muted;
    return {
      id: g.id,
      coordinator: g.coordinator,
      name: members.map((m) => m.name).join(" + "),
      members,
      state,
      volume,
      muted,
      track,
    };
  }

  // ---------- Kommandoer fra dashbordet ----------

  private group(id: string): SonosGroup | undefined {
    return this.state.groups.find((g) => g.id === id);
  }

  private player(uuid: string): SonosPlayer | undefined {
    return this.state.groups.flatMap((g) => g.members).find((m) => m.uuid === uuid);
  }

  hasGroup(id: string): boolean {
    return Boolean(this.group(id));
  }

  hasPlayer(uuid: string): boolean {
    return Boolean(this.player(uuid));
  }

  async transport(groupId: string, action: "play" | "pause" | "next" | "previous"): Promise<void> {
    const g = this.group(groupId);
    if (!g) throw new Error("Fant ikke rommet");
    const host = g.members.find((m) => m.uuid === g.coordinator)?.host ?? g.members[0].host;
    const name = { play: "Play", pause: "Pause", next: "Next", previous: "Previous" }[action];
    await soap(host, "AVTransport", name, action === "play" ? { InstanceID: 0, Speed: 1 } : { InstanceID: 0 });
    this.refreshSoon();
  }

  private coordinatorHost(g: SonosGroup): string {
    return g.members.find((m) => m.uuid === g.coordinator)?.host ?? g.members[0].host;
  }

  /** Spiller en Sonos-favoritt i et rom eller en gruppe. */
  async playFavorite(groupId: string, favoriteId: string): Promise<void> {
    const g = this.group(groupId);
    if (!g) throw new Error("Fant ikke rommet");
    if (!this.favorites.some((f) => f.id === favoriteId)) await this.loadFavorites();
    const fav = this.favorites.find((f) => f.id === favoriteId);
    if (!fav) throw new Error("Fant ikke favoritten");
    await this.playUri(g, fav.uri, fav.meta);
  }

  /** Spiller noe fra Spotify-søket, via Spotify-kontoen som er koblet til Sonos. */
  async playSpotify(
    groupId: string,
    type: "track" | "album" | "playlist" | "artist",
    id: string,
    title: string,
    sn?: string,
  ): Promise<void> {
    const g = this.group(groupId);
    if (!g) throw new Error("Fant ikke rommet");
    const pick = () => {
      const all = spotifyAccountsFrom(this.favorites);
      return all.find((a) => a.sn === sn) ?? all[0] ?? null;
    };
    let acc = pick();
    if (!acc || (sn && acc.sn !== sn)) {
      await this.loadFavorites();
      acc = pick();
    }
    if (!acc) {
      throw new Error("Fant ikke Spotify-kontoen i Sonos. Legg til en Spotify-spilleliste som favoritt i Sonos-appen først.");
    }
    const item = spotifyItem(type, id, title, acc);
    await this.playUri(g, item.uri, item.meta);
  }

  private async playUri(g: SonosGroup, uri: string, meta: string): Promise<void> {
    const host = this.coordinatorHost(g);
    if (playsDirect(uri)) {
      await soap(host, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: meta });
    } else {
      await soap(host, "AVTransport", "RemoveAllTracksFromQueue", { InstanceID: 0 });
      await soap(host, "AVTransport", "AddURIToQueue", {
        InstanceID: 0,
        EnqueuedURI: uri,
        EnqueuedURIMetaData: meta,
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: 0,
      });
      await soap(host, "AVTransport", "SetAVTransportURI", {
        InstanceID: 0,
        CurrentURI: `x-rincon-queue:${g.coordinator}#0`,
        CurrentURIMetaData: "",
      });
    }
    await soap(host, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
    this.refreshSoon();
  }

  /** Legger en høyttaler til i en annen gruppe, slik at den spiller det samme. */
  async join(uuid: string, groupId: string): Promise<void> {
    const p = this.player(uuid);
    const g = this.group(groupId);
    if (!p || !g) throw new Error("Fant ikke rommet");
    if (g.members.some((m) => m.uuid === uuid)) return;
    await soap(p.host, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${g.coordinator}`, CurrentURIMetaData: "" });
    this.topologyChanged();
  }

  /** Tar en høyttaler ut av gruppen sin, slik at den spiller for seg selv. */
  async leave(uuid: string): Promise<void> {
    const p = this.player(uuid);
    if (!p) throw new Error("Fant ikke høyttaleren");
    // Styrer høyttaleren gruppen, gis styringen videre først, slik at musikken fortsetter i de andre rommene.
    const g = this.state.groups.find((x) => x.coordinator === uuid && x.members.length > 1);
    const heir = g?.members.find((m) => m.uuid !== uuid);
    if (heir) {
      try {
        await soap(p.host, "AVTransport", "DelegateGroupCoordinationTo", { InstanceID: 0, NewCoordinator: heir.uuid, RejoinGroup: 0 });
        this.topologyChanged();
        return;
      } catch {
        // Eldre høyttalere kan mangle kommandoen. Da tas den ut på vanlig måte.
      }
    }
    await soap(p.host, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
    this.topologyChanged();
  }

  /** Alle høyttalere spiller det samme som denne gruppen. */
  async joinAll(groupId: string): Promise<void> {
    const g = this.group(groupId);
    if (!g) throw new Error("Fant ikke rommet");
    const others = this.state.groups.flatMap((x) => x.members).filter((m) => !g.members.some((y) => y.uuid === m.uuid));
    await Promise.all(
      others.map((m) =>
        soap(m.host, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${g.coordinator}`, CurrentURIMetaData: "" }),
      ),
    );
    this.topologyChanged();
  }

  /** Alle rom i gruppen spiller for seg selv igjen. Rommet som styrer gruppen, fortsetter å spille. */
  async splitGroup(groupId: string): Promise<void> {
    const g = this.group(groupId);
    if (!g) throw new Error("Fant ikke rommet");
    const others = g.members.filter((m) => m.uuid !== g.coordinator);
    await Promise.all(others.map((m) => soap(m.host, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 })));
    this.topologyChanged();
  }

  private topologyChanged(): void {
    this.topologyAt = 0;
    this.refreshSoon(600);
  }

  async setGroupVolume(groupId: string, opts: { volume?: number; mute?: boolean }): Promise<void> {
    const g = this.group(groupId);
    if (!g) throw new Error("Fant ikke rommet");
    if (g.members.length === 1) return this.setPlayerVolume(g.members[0].uuid, opts);
    const host = g.members.find((m) => m.uuid === g.coordinator)?.host ?? g.members[0].host;
    if (opts.volume !== undefined) await soap(host, "GroupRenderingControl", "SetGroupVolume", { InstanceID: 0, DesiredVolume: opts.volume });
    if (opts.mute !== undefined) await soap(host, "GroupRenderingControl", "SetGroupMute", { InstanceID: 0, DesiredMute: opts.mute ? 1 : 0 });
    this.refreshSoon();
  }

  async setPlayerVolume(uuid: string, opts: { volume?: number; mute?: boolean }): Promise<void> {
    const p = this.player(uuid);
    if (!p) throw new Error("Fant ikke høyttaleren");
    if (opts.volume !== undefined) {
      await soap(p.host, "RenderingControl", "SetVolume", { InstanceID: 0, Channel: "Master", DesiredVolume: opts.volume });
    }
    if (opts.mute !== undefined) {
      await soap(p.host, "RenderingControl", "SetMute", { InstanceID: 0, Channel: "Master", DesiredMute: opts.mute ? 1 : 0 });
    }
    this.refreshSoon();
  }
}
