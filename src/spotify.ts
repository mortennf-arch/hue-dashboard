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

  async search(query: string): Promise<SpotifyHit[]> {
    if (!this.configured) throw new Error("Spotify er ikke satt opp");
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", q);
    url.searchParams.set("type", "artist,album,playlist,track");
    url.searchParams.set("market", "NO");
    url.searchParams.set("limit", "6");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) this.token = "";
    if (!res.ok) throw new Error(`Spotify-søket feilet (${res.status})`);
    // Spotify kan gi null-elementer i listene, så alt sjekkes.
    const data = (await res.json()) as Record<string, { items?: (Record<string, any> | null)[] } | undefined>;
    const items = (key: string) => (data[key]?.items ?? []).filter((x): x is Record<string, any> => Boolean(x?.id));
    const names = (list: { name?: string }[] | undefined) => (list ?? []).map((a) => a.name).filter(Boolean).join(", ");
    return [
      ...items("artists").slice(0, 3).map((a): SpotifyHit => ({ type: "artist", id: a.id, title: a.name, subtitle: "Artistradio", art: pickImage(a.images) })),
      ...items("tracks").map((t): SpotifyHit => ({ type: "track", id: t.id, title: t.name, subtitle: names(t.artists), art: pickImage(t.album?.images) })),
      ...items("albums").map((a): SpotifyHit => ({ type: "album", id: a.id, title: a.name, subtitle: `Album · ${names(a.artists)}`, art: pickImage(a.images) })),
      ...items("playlists").map((p): SpotifyHit => ({
        type: "playlist",
        id: p.id,
        title: p.name,
        subtitle: `Spilleliste${p.owner?.display_name ? ` · ${p.owner.display_name}` : ""}`,
        art: pickImage(p.images),
      })),
    ];
  }
}
