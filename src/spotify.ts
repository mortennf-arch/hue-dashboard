/**
 * Søk i Spotify med appens egne nøkler (client credentials). Det trengs ingen innlogging fra brukeren,
 * fordi selve avspillingen går gjennom Spotify-kontoen som allerede er koblet til Sonos.
 *
 * Nøklene lages på developer.spotify.com/dashboard og settes som SPOTIFY_CLIENT_ID og SPOTIFY_CLIENT_SECRET.
 */

export type SpotifyType = "track" | "album" | "playlist" | "artist";

export interface SpotifyHit {
  type: SpotifyType;
  id: string;
  title: string;
  subtitle: string;
  art: string;
}

interface Image {
  url: string;
  width?: number | null;
}

/** Velger et bilde som er stort nok til en knapp, men ikke større enn nødvendig. */
function pickImage(images: Image[] | undefined): string {
  if (!images?.length) return "";
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 200) ?? sorted[sorted.length - 1]).url;
}

export class SpotifyClient {
  private token = "";
  private tokenExpires = 0;

  constructor(
    private readonly clientId = process.env.SPOTIFY_CLIENT_ID ?? "",
    private readonly clientSecret = process.env.SPOTIFY_CLIENT_SECRET ?? "",
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.access_token) {
      throw new Error(
        data.error === "invalid_client"
          ? "Spotify godtar ikke nøklene. Sjekk SPOTIFY_CLIENT_ID og SPOTIFY_CLIENT_SECRET."
          : `Spotify svarte ${res.status} ved innlogging`,
      );
    }
    this.token = data.access_token;
    this.tokenExpires = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }

  /**
   * Søker i Spotify. Uten type hentes noen få av hver type og et «beste treff». Med type hentes flere av
   * den typen, side for side med offset.
   */
  private async get(path: string, params: Record<string, string> = {}): Promise<Record<string, any>> {
    const url = new URL(`https://api.spotify.com/v1/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) this.token = "";
    if (!res.ok) throw new Error(`Spotify svarte ${res.status} for ${path.split("/")[0]}`);
    return (await res.json()) as Record<string, any>;
  }

  /**
   * Artistsiden: mest spilte sanger, album og singler, der artisten er med (featuring), og «This Is»-listen.
   * Hver del hentes for seg. Svarer Spotify ikke på en del, blir den bare tom, så resten vises likevel.
   */
  async artist(id: string): Promise<SpotifyArtist> {
    if (!this.configured) throw new Error("Spotify er ikke satt opp");
    const [info, top, albums, appears] = await Promise.allSettled([
      this.get(`artists/${id}`),
      this.get(`artists/${id}/top-tracks`, { market: "NO" }),
      this.get(`artists/${id}/albums`, { include_groups: "album,single", market: "NO", limit: "20" }),
      this.get(`artists/${id}/albums`, { include_groups: "appears_on", market: "NO", limit: "20" }),
    ]);
    const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
    if (info.status === "rejected") throw info.reason;
    const a = info.value;
    const name: string = a.name ?? "Artist";
    const list = (x: Record<string, any> | null, key: string) => ((x?.[key] ?? []) as (Record<string, any> | null)[]).filter((v): v is Record<string, any> => Boolean(v?.id));
    // Spotify gir ofte samme album flere ganger (utgaver for ulike land). Navnet holder for å rydde.
    const uniqueByTitle = (hits: SpotifyHit[]) => hits.filter((h, i) => hits.findIndex((x) => x.title.toLocaleLowerCase("nb") === h.title.toLocaleLowerCase("nb")) === i);
    const thisIs = await this.thisIs(name).catch(() => null);
    return {
      artist: { type: "artist", id, title: name, subtitle: "Artistradio", art: pickImage(a.images) },
      topTracks: list(val(top), "tracks").slice(0, 10).map(trackHit),
      albums: uniqueByTitle(list(val(albums), "items").map(albumHit)),
      appearsOn: uniqueByTitle(list(val(appears), "items").map(albumHit)),
      thisIs,
    };
  }

  /** Finner Spotifys egen «This Is <artist>»-liste, hvis søket gir den. */
  private async thisIs(name: string): Promise<SpotifyHit | null> {
    const data = await this.get("search", { q: `This Is ${name}`, type: "playlist", market: "NO", limit: "10" });
    const want = `this is ${name}`.toLocaleLowerCase("nb");
    const p = ((data.playlists?.items ?? []) as (Record<string, any> | null)[]).find(
      (x) => x?.id && String(x.name ?? "").toLocaleLowerCase("nb") === want,
    );
    return p ? playlistHit(p) : null;
  }

  async search(query: string, type?: SpotifyType, offset = 0): Promise<SpotifySearch> {
    if (!this.configured) throw new Error("Spotify er ikke satt opp");
    const q = query.trim().slice(0, 100);
    if (!q) return { top: null, results: [], more: false };
    const limit = type ? PAGE : 6;
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", q);
    url.searchParams.set("type", type ?? "artist,album,playlist,track");
    url.searchParams.set("market", "NO");
    url.searchParams.set("limit", String(limit));
    if (type && offset > 0) url.searchParams.set("offset", String(Math.min(offset, 900)));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) this.token = "";
    if (!res.ok) throw new Error(`Spotify-søket feilet (${res.status})`);
    // Spotify kan gi null-elementer i listene, så alt sjekkes.
    const data = (await res.json()) as Record<string, { items?: (Record<string, any> | null)[]; next?: string | null } | undefined>;
    const items = (key: string) => (data[key]?.items ?? []).filter((x): x is Record<string, any> => Boolean(x?.id));
    const artists = items("artists").map((a): SpotifyHit => ({ type: "artist", id: a.id, title: a.name, subtitle: "Artistradio", art: pickImage(a.images) }));
    const tracks = items("tracks").map(trackHit);
    const albums = items("albums").map(albumHit);
    // Spillelister laget av Spotify selv er som regel best vedlikeholdt, så de kommer først.
    const playlistItems = items("playlists");
    const byOwner = [...playlistItems.filter((p) => p.owner?.id === "spotify"), ...playlistItems.filter((p) => p.owner?.id !== "spotify")];
    const playlists = byOwner.map(playlistHit);
    if (type) {
      const key = `${type}s`;
      const results = { artists, tracks, albums, playlists }[key as "artists"] ?? [];
      return { top: null, results, more: Boolean(data[key]?.next) && offset + PAGE < 1000 };
    }
    const results = [...artists.slice(0, 3), ...tracks, ...albums, ...playlists];
    return { top: bestHit(q, artists, tracks, albums, playlists), results, more: false };
  }
}

const PAGE = 10;

const names = (list: { name?: string }[] | undefined) => (list ?? []).map((a) => a.name).filter(Boolean).join(", ");
const trackHit = (t: Record<string, any>): SpotifyHit => ({ type: "track", id: t.id, title: t.name, subtitle: names(t.artists), art: pickImage(t.album?.images) });
const albumHit = (a: Record<string, any>): SpotifyHit => ({
  type: "album",
  id: a.id,
  title: a.name,
  subtitle: `${a.album_type === "single" ? "Singel" : a.album_type === "compilation" ? "Samling" : "Album"}${a.release_date ? ` · ${String(a.release_date).slice(0, 4)}` : ""} · ${names(a.artists)}`,
  art: pickImage(a.images),
});
const playlistHit = (p: Record<string, any>): SpotifyHit => ({
  type: "playlist",
  id: p.id,
  title: p.name,
  subtitle: `Spilleliste${p.owner?.display_name ? ` · ${p.owner.display_name}` : ""}`,
  art: pickImage(p.images),
});

export interface SpotifyArtist {
  artist: SpotifyHit;
  topTracks: SpotifyHit[];
  albums: SpotifyHit[];
  appearsOn: SpotifyHit[];
  thisIs: SpotifyHit | null;
}

export interface SpotifySearch {
  /** Det beste treffet, vist stort øverst. Bare når det søkes i alle typer. */
  top: SpotifyHit | null;
  results: SpotifyHit[];
  /** Det finnes flere treff av typen det søkes i. */
  more: boolean;
}

const norm = (s: string) => s.toLocaleLowerCase("nb").replace(/\s+/g, " ").trim();

/** Velger det beste treffet: en artist som heter akkurat det hun skrev, ellers første sang eller noe annet. */
export function bestHit(q: string, artists: SpotifyHit[], tracks: SpotifyHit[], albums: SpotifyHit[], playlists: SpotifyHit[]): SpotifyHit | null {
  const n = norm(q);
  const exact = (list: SpotifyHit[]) => list.find((h) => norm(h.title) === n);
  return exact(artists) ?? exact(tracks) ?? exact(albums) ?? exact(playlists) ?? artists[0] ?? tracks[0] ?? albums[0] ?? playlists[0] ?? null;
}
