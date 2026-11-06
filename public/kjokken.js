// Kjøkkenvisning for nettbrettet. Bruker samme hendelsesstrøm og samme API som dashbordet.
//
// Musikk: rommene som er merket med gult, spiller sammen. Et trykk på et rom legger det til i gruppen
// eller tar det ut. Gruppen holdes rede på med én høyttaler («ankeret»), siden gruppens id kan endre seg.

const byId = new Map();
let sonos = null;
let sonosAt = 0; // da siste Sonos-tilstand kom, for å regne ut hvor langt sangen har kommet
let spotifyOn = false;
let online = false;
let weather = null; // fra /api/weather
let waste = null; // fra /api/waste
let timers = []; // fra serveren, se timer.js

// ---------- Hjelpere ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

const collator = new Intl.Collator("nb");
const shortTime = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" });
const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(text) {
  const el = $("k-toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  } catch (err) {
    console.error(err);
    toast(`Det gikk ikke: ${err.message}`);
    return null;
  }
}

/** Sender høyst én verdi per tidsrom og alltid den siste, slik at en glidebryter ikke drukner høyttaleren. */
function throttled(ms, fn) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (v) => {
    pending = v;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn(pending);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(pending);
      }, wait);
    }
  };
}

const PLAY_SVG = '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
const PAUSE_SVG =
  '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const MUSIC_SVG =
  '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

const sonosUrl = (kind, id, action) => `/api/sonos/${kind}/${encodeURIComponent(id)}/${action}`;

/** Bilde som forsvinner stille hvis det ikke kan lastes. */
function artImg(url) {
  if (!url) return null;
  const img = h("img", { src: url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.remove());
  return img;
}

function setFill(input) {
  input.style.setProperty("--fill", `${input.value}%`);
}

// ---------- Faner ----------

const TABS = ["musikk", "lys", "idag", "sikkerhet"];
let tab = TABS.includes(storage("kTab")) ? storage("kTab") : "musikk";

const visibleTabs = () => TABS.filter((t) => !$(`tab-${t}`).hidden);

function showTab(name, remember = true) {
  if (!visibleTabs().includes(name)) name = "musikk";
  else if (remember) storage("kTab", name);
  tab = name;
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    btn.setAttribute("aria-selected", String(t === name));
    btn.tabIndex = t === name ? 0 : -1;
    $(`k-${t}`).hidden = t !== name;
  }
}

for (const btn of document.querySelectorAll("[role=tab]")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
  btn.addEventListener("keydown", (e) => {
    const list = visibleTabs();
    const i = list.indexOf(btn.dataset.tab);
    const next = e.key === "ArrowRight" ? list[(i + 1) % list.length] : e.key === "ArrowLeft" ? list[(i + list.length - 1) % list.length] : null;
    if (!next) return;
    e.preventDefault();
    showTab(next);
    $(`tab-${next}`).focus();
  });
}
showTab(tab, false);

// ---------- Klokke ----------

const dateFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long" });
function tick() {
  const now = new Date();
  $("k-clock").textContent = shortTime.format(now);
  $("k-date").textContent = dateFmt.format(now);
}
tick();
setInterval(tick, 5000);

// ---------- Musikk: hvilke rom som spiller sammen ----------

// Ankeret er en høyttaler i gruppen som styres. "none" betyr at hun bevisst har tatt bort alle rom.
let anchor = storage("kAnchor");
const pending = new Map(); // uuid -> { want: boolean, until: tid }

function setAnchor(uuid) {
  anchor = uuid ?? "none";
  storage("kAnchor", anchor);
}

const groupWith = (uuid) => sonos?.groups.find((g) => g.members.some((m) => m.uuid === uuid)) ?? null;

function currentGroup() {
  if (!sonos?.groups?.length) return null;
  if (anchor === null) {
    // Første gang på denne skjermen: velg det som spiller nå, ellers ingenting.
    const playing = sonos.groups.find((g) => g.state === "playing");
    if (!playing) return null;
    setAnchor(playing.coordinator);
  }
  if (anchor === "none") return null;
  return groupWith(anchor);
}

function allPlayers() {
  const list = (sonos?.groups ?? []).flatMap((g) => g.members.map((m) => ({ ...m, group: g })));
  return list.sort((a, b) => collator.compare(a.name, b.name));
}

/** Er rommet merket? Et trykk som ikke er bekreftet av høyttalerne ennå, teller med en stund. */
function isSelected(uuid, g) {
  const p = pending.get(uuid);
  if (p) {
    const actual = Boolean(g?.members.some((m) => m.uuid === uuid));
    if (actual === p.want || Date.now() > p.until) pending.delete(uuid);
    else return p.want;
  }
  return Boolean(g?.members.some((m) => m.uuid === uuid));
}

function selectedPlayers(g) {
  return allPlayers().filter((p) => isSelected(p.uuid, g));
}

async function toggleRoom(uuid) {
  const g = currentGroup();
  const on = isSelected(uuid, g);
  if (!on) {
    if (!g) {
      // Ingen rom er valgt: rommet blir valgt, sammen med rommene det alt spiller sammen med.
      setAnchor(uuid);
      render();
      return;
    }
    pending.set(uuid, { want: true, until: Date.now() + 8000 });
    render();
    const ok = await api("POST", sonosUrl("player", uuid, "join"), { groupId: g.id });
    if (!ok) pending.delete(uuid);
    render();
    return;
  }
  const chosen = selectedPlayers(g);
  if (chosen.length > 1) {
    if (uuid === anchor) setAnchor(chosen.find((p) => p.uuid !== uuid).uuid);
    pending.set(uuid, { want: false, until: Date.now() + 8000 });
    render();
    const ok = await api("POST", sonosUrl("player", uuid, "leave"));
    if (!ok) pending.delete(uuid);
    render();
    return;
  }
  // Det siste rommet tas bort: musikken stoppes der, og ingen rom er valgt.
  const grp = groupWith(uuid);
  setAnchor(null);
  render();
  if (grp?.state === "playing") await api("POST", sonosUrl("group", grp.id, "pause"));
}

// ---------- Musikk: tegning ----------

const roomEls = new Map(); // uuid -> knapp

function roomSub(p, selected, g) {
  const grp = p.group;
  if (selected) {
    if (pending.has(p.uuid)) return "Kobles til …";
    return g?.state === "playing" ? "Spiller her" : "Valgt";
  }
  if (pending.has(p.uuid)) return "Tas ut …";
  if (grp.state === "playing" && (!g || grp.id !== g.id)) {
    const t = grp.track?.title;
    return t ? `Spiller ${t}` : "Spiller noe annet";
  }
  return "Stille";
}

function renderRooms(g) {
  const list = $("k-room-list");
  const players = allPlayers();
  const hint = $("k-rooms-hint");
  if (!sonos) {
    hint.hidden = false;
    hint.textContent = "Sonos er ikke satt opp på serveren.";
  } else if (!sonos.available) {
    hint.hidden = false;
    hint.textContent = sonos.reason || "Leter etter høyttalere …";
  } else hint.hidden = true;

  const ids = players.map((p) => p.uuid);
  for (const [id, el] of roomEls) {
    if (!ids.includes(id)) {
      el.remove();
      roomEls.delete(id);
    }
  }
  players.forEach((p, i) => {
    let el = roomEls.get(p.uuid);
    if (!el) {
      el = h("button", { type: "button", class: "k-room", onclick: () => toggleRoom(p.uuid) }, h("strong"), h("span"));
      roomEls.set(p.uuid, el);
    }
    const sel = isSelected(p.uuid, g);
    el.setAttribute("aria-pressed", String(sel));
    el.classList.toggle("busy", pending.has(p.uuid));
    el.children[0].textContent = p.name;
    el.children[1].textContent = roomSub(p, sel, g);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
  });
}

// Glidebrytere som brukeren holder i, skal ikke hoppe tilbake når nye verdier kommer fra høyttalerne.
const holding = new Map(); // input -> tid da den kan oppdateres igjen
const volRows = new Map(); // nøkkel -> { row, input, out }

function volumeRow(key, label, cls, send) {
  const id = `k-vol-${key.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const input = h("input", { id, type: "range", min: 0, max: 100, step: 1 });
  const out = h("output", { for: id });
  const push = throttled(200, send);
  input.addEventListener("pointerdown", () => holding.set(input, Infinity));
  const release = () => holding.set(input, Date.now() + 2500);
  input.addEventListener("pointerup", release);
  input.addEventListener("pointercancel", release);
  input.addEventListener("input", () => {
    if (!holding.has(input)) holding.set(input, Date.now() + 2500);
    else if (holding.get(input) !== Infinity) holding.set(input, Date.now() + 2500);
    out.textContent = input.value;
    setFill(input);
    push(Number(input.value));
  });
  const row = h("div", { class: `k-vol ${cls}` }, h("label", { for: id }, label), input, out);
  return { row, input, out };
}

function setVolume(entry, value) {
  const until = holding.get(entry.input);
  if (until !== undefined && (until === Infinity || Date.now() < until)) return;
  holding.delete(entry.input);
  entry.input.value = String(value);
  entry.out.textContent = String(value);
  setFill(entry.input);
}

function renderVolumes(g) {
  const box = $("k-volumes");
  const rows = [];
  if (g.members.length > 1) {
    const key = `group:${g.id}`;
    if (!volRows.has(key)) {
      volRows.set(key, volumeRow(key, "Alle rom", "master", (v) => api("PUT", sonosUrl("group", g.id, "volume"), { volume: v })));
    }
    const e = volRows.get(key);
    setVolume(e, g.volume);
    rows.push([key, e]);
  }
  for (const m of g.members) {
    const key = `player:${m.uuid}`;
    const label = g.members.length > 1 ? m.name : "Volum";
    let e = volRows.get(key);
    if (e && e.label !== label) {
      e.row.remove();
      e = null;
    }
    if (!e) {
      e = volumeRow(key, label, "", (v) => api("PUT", sonosUrl("player", m.uuid, "volume"), { volume: v }));
      e.label = label;
      volRows.set(key, e);
    }
    setVolume(e, m.volume);
    rows.push([key, e]);
  }
  const keep = new Set(rows.map(([k]) => k));
  for (const [k, e] of volRows) {
    if (!keep.has(k)) {
      e.row.remove();
      volRows.delete(k);
    }
  }
  rows.forEach(([, e], i) => {
    if (box.children[i] !== e.row) box.insertBefore(e.row, box.children[i] ?? null);
  });
}

let artKey = "";
function renderNow(g) {
  const empty = $("k-now-empty");
  const body = $("k-now-body");
  const head = $("k-now-h");
  if (!g) {
    head.textContent = "Spilles nå";
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  const names = g.members.map((m) => m.name);
  head.textContent = names.length <= 3 ? `Spilles nå i ${names.join(" + ")}` : `Spilles nå i ${names.length} rom`;
  $("k-now-h").parentElement.classList.toggle("many", g.members.length > 2);

  const t = g.track;
  const playing = g.state === "playing" || g.state === "transitioning";
  $("k-title").textContent = t?.title || "Ingenting spilles";
  $("k-artist").textContent = t ? t.artist || t.album || "" : "Velg musikk til høyre";
  $("k-source").textContent = t?.source && t.source !== t.title ? t.source : "";
  const art = $("k-art");
  const key = t?.art ?? "";
  if (key !== artKey) {
    artKey = key;
    art.innerHTML = MUSIC_SVG;
    const img = artImg(key);
    if (img) {
      img.addEventListener("error", () => (art.innerHTML = MUSIC_SVG));
      art.replaceChildren(img);
    }
  }
  const play = $("k-play");
  const wantKey = playing ? "pause" : "play";
  if (play.dataset.mode !== wantKey) {
    play.dataset.mode = wantKey;
    play.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    play.setAttribute("aria-label", playing ? "Pause" : "Spill");
  }
  renderProgress(g);
  renderUpNext(g);
  renderVolumes(g);
}

const fmtDur = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
};

// Mens hun drar i fremdriftslinjen, eller rett etter, skal den ikke hoppe tilbake til det høyttalerne sa sist.
let seekHold = null; // { value, until }

/** Fremdriftslinjen. Høyttalerne spørres hvert andre sekund, og imens regnes tiden videre her. */
function renderProgress(g) {
  const box = $("k-progress");
  const t = g?.track;
  if (!t || !t.duration) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const seek = $("k-seek");
  const playing = g.state === "playing";
  let pos = Math.min(t.duration, t.position + (playing ? (Date.now() - sonosAt) / 1000 : 0));
  // Når høyttalerne melder omtrent samme sted som hun dro til, slippes holdet med en gang.
  if (seekHold && seekHold.until !== Infinity && Math.abs(pos - seekHold.value) < 3) seekHold = null;
  if (seekHold && (seekHold.until === Infinity || Date.now() < seekHold.until)) pos = seekHold.value;
  else seekHold = null;
  seek.max = String(t.duration);
  seek.value = String(Math.round(pos));
  seek.style.setProperty("--fill", `${(pos / t.duration) * 100}%`);
  seek.setAttribute("aria-valuetext", `${fmtDur(pos)} av ${fmtDur(t.duration)}`);
  $("k-pos").textContent = fmtDur(pos);
  $("k-dur").textContent = fmtDur(t.duration);
}
setInterval(() => {
  if (tab === "musikk" && !document.hidden) renderProgress(currentGroup());
}, 1000);

{
  const seek = $("k-seek");
  seek.addEventListener("pointerdown", () => (seekHold = { value: Number(seek.value), until: Infinity }));
  seek.addEventListener("input", () => {
    seekHold = { value: Number(seek.value), until: Infinity };
    renderProgress(currentGroup());
  });
  seek.addEventListener("change", async () => {
    const g = currentGroup();
    const value = Number(seek.value);
    // Hold igjen den nye plassen til høyttalerne har rukket å melde den.
    seekHold = { value, until: Date.now() + 4000 };
    if (g) await api("POST", sonosUrl("group", g.id, "seek"), { position: value });
  });
}

/** Hele resten av køen, under volumet. Et trykk på en sang hopper dit. */
function renderUpNext(g) {
  const box = $("k-upnext");
  const items = g?.upNext ?? [];
  box.hidden = !items.length;
  $("k-upnext-h").textContent = items.length ? `Neste i køen (${items.length}${items.length >= 100 ? "+" : ""})` : "Neste i køen";
  const list = $("k-upnext-list");
  const key = JSON.stringify(items);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(
    ...items.map((it) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "k-queue-item",
            "aria-label": `Spill ${it.title}${it.artist ? ` av ${it.artist}` : ""}`,
            onclick: () => {
              const grp = currentGroup();
              if (grp) api("POST", sonosUrl("group", grp.id, "track"), { number: it.number });
            },
          },
          h("span", { class: "k-row-art small", "aria-hidden": "true" }, artImg(it.art)),
          h("span", { class: "k-row-text" }, h("strong", {}, it.title), it.artist ? h("span", {}, it.artist) : null),
        ),
      ),
    ),
  );
}

for (const [id, action] of [
  ["k-prev", "previous"],
  ["k-next", "next"],
]) {
  $(id).addEventListener("click", () => {
    const g = currentGroup();
    if (g) api("POST", sonosUrl("group", g.id, action));
  });
}
$("k-play").addEventListener("click", () => {
  const g = currentGroup();
  if (!g) return;
  api("POST", sonosUrl("group", g.id, $("k-play").dataset.mode === "pause" ? "pause" : "play"));
});

// ---------- Musikk: favoritter og Spotify ----------

/** Spiller noe i rommene som er valgt. Uten valgte rom får hun beskjed om å velge rom først. */
async function playIn(send) {
  const g = currentGroup();
  if (!g) {
    toast("Velg rom til venstre først");
    const rooms = document.querySelector(".k-rooms");
    rooms.classList.remove("nudge");
    void rooms.offsetWidth;
    rooms.classList.add("nudge");
    setTimeout(() => rooms.classList.remove("nudge"), 2500);
    return false;
  }
  return Boolean(await send(g));
}

function musicTile(title, sub, art, send, after) {
  const btn = h(
    "button",
    {
      type: "button",
      class: "k-fav",
      onclick: async () => {
        btn.disabled = true;
        const ok = await playIn(send);
        btn.disabled = false;
        if (ok && after) after();
      },
    },
    h("span", { class: "k-fav-art", "aria-hidden": "true" }, artImg(art)),
    h("strong", {}, title),
    sub ? h("span", {}, sub) : null,
  );
  return btn;
}

function renderFavorites() {
  const favs = sonos?.favorites ?? [];
  const grid = $("k-favs");
  const key = JSON.stringify(favs);
  const hint = $("k-favs-hint");
  hint.hidden = favs.length > 0 || !sonos?.available;
  hint.textContent = "Ingen favoritter ennå. Trykk på hjertet ved en spilleliste eller radiokanal i Sonos-appen, så dukker den opp her.";
  if (grid.dataset.key === key) return;
  grid.dataset.key = key;
  grid.replaceChildren(
    ...favs.map((f) => musicTile(f.title, f.kind, f.art, (g) => api("POST", sonosUrl("group", g.id, "favorite"), { favoriteId: f.id }))),
  );
}

let spotifyAccount = storage("spotifyAccount") ?? "";
function currentAccount() {
  const list = sonos?.spotifyAccounts ?? [];
  return list.find((a) => a.sn === spotifyAccount) ?? list[0] ?? null;
}

function renderAccounts() {
  const list = sonos?.spotifyAccounts ?? [];
  const box = $("k-accounts");
  box.hidden = list.length < 2;
  if (box.hidden) return;
  const cur = currentAccount();
  const wrap = $("k-account-list");
  const key = JSON.stringify([list, cur?.sn]);
  if (wrap.dataset.key === key) return;
  wrap.dataset.key = key;
  wrap.replaceChildren(
    ...list.map((a) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(a.sn === cur?.sn),
          onclick: () => {
            spotifyAccount = a.sn;
            storage("spotifyAccount", a.sn);
            renderAccounts();
          },
        },
        a.name,
      ),
    ),
  );
}

// ---------- Spotify-søk med filter ----------

const TYPE_NAME = { artist: "Artist", track: "Sang", album: "Album", playlist: "Spilleliste" };
const SECTIONS = [
  ["track", "Sanger"],
  ["artist", "Artister"],
  ["album", "Album"],
  ["playlist", "Spillelister"],
];
let searchFilter = "";
let searchSeq = 0;
let searchOffset = 0;

const playHit = (r) => (g) => api("POST", sonosUrl("group", g.id, "spotify"), { type: r.type, id: r.id, title: r.title, account: currentAccount()?.sn });
const closeSearch = () => $("k-search").close();

function hitTile(r) {
  // En artist åpner artistsiden. Alt annet spilles med en gang.
  if (r.type === "artist") {
    const btn = h(
      "button",
      { type: "button", class: "k-fav", onclick: () => showArtist(r.id) },
      h("span", { class: "k-fav-art round", "aria-hidden": "true" }, artImg(r.art)),
      h("strong", {}, r.title),
      h("span", {}, "Artist"),
    );
    return btn;
  }
  return musicTile(r.title, r.subtitle, r.art, playHit(r), closeSearch);
}

/** En sang som en rad med lite bilde, slik musikkappene viser sanger. */
function trackRow(r) {
  const btn = h(
    "button",
    {
      type: "button",
      class: "k-row",
      onclick: async () => {
        btn.disabled = true;
        const ok = await playIn(playHit(r));
        btn.disabled = false;
        if (ok) closeSearch();
      },
    },
    h("span", { class: "k-row-art", "aria-hidden": "true" }, artImg(r.art)),
    h("span", { class: "k-row-text" }, h("strong", {}, r.title), h("span", {}, r.subtitle)),
  );
  return btn;
}

function hitsOf(type, hits) {
  return type === "track" ? h("div", { class: "k-rows" }, hits.map(trackRow)) : h("div", { class: "k-fav-grid k-tiles" }, hits.map(hitTile));
}

function topHit(r) {
  const btn = h(
    "button",
    {
      type: "button",
      class: "k-top-hit",
      onclick: async () => {
        if (r.type === "artist") return showArtist(r.id);
        btn.disabled = true;
        const ok = await playIn(playHit(r));
        btn.disabled = false;
        if (ok) closeSearch();
      },
    },
    h("span", { class: `k-top-art${r.type === "artist" ? " round" : ""}`, "aria-hidden": "true" }, artImg(r.art)),
    h(
      "span",
      { class: "k-row-text" },
      h("small", {}, `Beste treff · ${TYPE_NAME[r.type]}`),
      h("strong", {}, r.title),
      h("span", {}, r.type === "artist" ? "Se sanger, album og artistradio" : r.subtitle),
    ),
  );
  return btn;
}

// ---------- Artistside ----------

let savedResults = null; // søketreffene som var der før artistsiden ble åpnet

/** En sang fra artistens mest spilte. Sangen spilles, og resten av listen legges i køen etter den. */
function topTrackRow(r, i, all) {
  const btn = h(
    "button",
    {
      type: "button",
      class: "k-row",
      onclick: async () => {
        btn.disabled = true;
        const then = all.slice(i + 1).map((t) => ({ id: t.id, title: t.title }));
        const ok = await playIn((g) =>
          api("POST", sonosUrl("group", g.id, "spotify"), { type: "track", id: r.id, title: r.title, account: currentAccount()?.sn, then }),
        );
        btn.disabled = false;
        if (ok) closeSearch();
      },
    },
    h("span", { class: "k-num" }, String(i + 1)),
    h("span", { class: "k-row-art", "aria-hidden": "true" }, artImg(r.art)),
    h("span", { class: "k-row-text" }, h("strong", {}, r.title), h("span", {}, r.subtitle)),
  );
  return btn;
}

function backToSearch() {
  const list = $("k-results");
  $("k-filters").hidden = false;
  if (savedResults) list.replaceChildren(...savedResults);
  savedResults = null;
  list.scrollTop = 0;
}

async function showArtist(id) {
  const list = $("k-results");
  const hint = $("k-search-hint");
  if (!savedResults) savedResults = [...list.childNodes];
  $("k-filters").hidden = true;
  const back = h(
    "button",
    { type: "button", class: "k-back", onclick: backToSearch },
    h("span", { "aria-hidden": "true" }, "‹"),
    "Tilbake til søket",
  );
  list.replaceChildren(back);
  hint.hidden = false;
  hint.textContent = "Henter artisten …";
  const seq = ++searchSeq;
  try {
    const res = await fetch(`/api/spotify/artist/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    hint.hidden = true;
    const a = data.artist;
    const radio = h(
      "button",
      {
        type: "button",
        class: "k-primary",
        onclick: async () => {
          radio.disabled = true;
          const ok = await playIn(playHit(a));
          radio.disabled = false;
          if (ok) closeSearch();
        },
      },
      "Spill artistradio",
    );
    const parts = [
      back,
      h(
        "div",
        { class: "k-artist-head" },
        h("span", { class: "k-top-art round", "aria-hidden": "true" }, artImg(a.art)),
        h("div", {}, h("h3", {}, a.title), radio),
      ),
    ];
    const section = (label, body) => h("section", { class: "k-section" }, h("div", { class: "k-section-head" }, h("h3", {}, label)), body);
    if (data.topTracks?.length) parts.push(section("Populære sanger", h("div", { class: "k-rows" }, data.topTracks.map(topTrackRow))));
    if (data.thisIs) parts.push(section(`This Is ${a.title}`, h("div", { class: "k-fav-grid k-tiles" }, hitTile(data.thisIs))));
    if (data.albums?.length) parts.push(section("Album og singler", h("div", { class: "k-fav-grid k-tiles" }, data.albums.map(hitTile))));
    // «Med på» kan være album eller sanger, alt etter hva Spotify lar oss hente.
    if (data.appearsOn?.length) parts.push(section("Med på (featuring)", hitsOf(data.appearsOn[0].type, data.appearsOn)));
    list.replaceChildren(...parts);
    list.scrollTop = 0;
  } catch (err) {
    if (seq !== searchSeq) return;
    hint.textContent = `Fikk ikke hentet artisten: ${err.message}`;
  }
}

function setFilter(type) {
  searchFilter = type;
  for (const b of document.querySelectorAll("#k-filters button")) b.setAttribute("aria-pressed", String(b.dataset.filter === type));
  runSearch($("k-q").value);
}

async function runSearch(q, more = false) {
  const seq = ++searchSeq;
  if (savedResults && !more) {
    savedResults = null;
    $("k-filters").hidden = false;
  }
  const hint = $("k-search-hint");
  const list = $("k-results");
  if (!q.trim()) {
    hint.hidden = true;
    list.replaceChildren();
    return;
  }
  if (!more) {
    searchOffset = 0;
    hint.hidden = false;
    hint.textContent = "Søker …";
  }
  try {
    const params = new URLSearchParams({ q });
    if (searchFilter) params.set("type", searchFilter);
    if (more) params.set("offset", String(searchOffset));
    const res = await fetch(`/api/spotify/search?${params}`);
    const data = await res.json().catch(() => ({}));
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const hits = data.results ?? [];
    list.querySelector(".k-more")?.remove();

    if (searchFilter) {
      // Én type: flere treff, og «Vis flere» henter neste side.
      searchOffset += hits.length;
      if (!more) list.replaceChildren(hitsOf(searchFilter, hits));
      else list.firstElementChild?.append(...(searchFilter === "track" ? hits.map(trackRow) : hits.map(hitTile)));
      hint.hidden = searchOffset > 0;
      hint.textContent = "Fant ingenting. Prøv et annet ord.";
      if (data.more && hits.length) {
        list.append(h("button", { type: "button", class: "k-secondary k-more", onclick: () => runSearch(q, true) }, "Vis flere"));
      }
      return;
    }

    // Alt: beste treff øverst, så noen få av hver type under hver sin overskrift.
    const top = data.top;
    const same = (a, b) => a && b && a.type === b.type && a.id === b.id;
    const parts = [];
    if (top) parts.push(topHit(top));
    for (const [type, label] of SECTIONS) {
      const of = hits.filter((r) => r.type === type && !same(r, top)).slice(0, 4);
      if (!of.length) continue;
      parts.push(
        h(
          "section",
          { class: "k-section" },
          h("div", { class: "k-section-head" }, h("h3", {}, label), h("button", { type: "button", class: "k-link", onclick: () => setFilter(type) }, "Vis alle")),
          hitsOf(type, of),
        ),
      );
    }
    hint.hidden = parts.length > 0;
    hint.textContent = "Fant ingenting. Prøv et annet ord.";
    list.replaceChildren(...parts);
    list.scrollTop = 0;
  } catch (err) {
    if (seq !== searchSeq) return;
    hint.hidden = false;
    hint.textContent = `Søket feilet: ${err.message}`;
  }
}

{
  const input = $("k-q");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 400);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    clearTimeout(timer);
    input.blur(); // lukker tastaturet så treffene synes
    runSearch(input.value);
  });
  for (const b of document.querySelectorAll("#k-filters button")) b.addEventListener("click", () => setFilter(b.dataset.filter));
  $("k-search-open").addEventListener("click", () => {
    delete $("k-account-list").dataset.key;
    renderAccounts();
    if (savedResults) backToSearch();
    if (searchFilter) setFilter("");
    $("k-search").showModal();
    input.focus();
    input.select();
  });
  $("k-search-close").addEventListener("click", () => $("k-search").close());
  $("k-search").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
}

function renderMusic() {
  const g = currentGroup();
  renderRooms(g);
  renderNow(g);
  renderFavorites();
  $("k-search-open").hidden = !spotifyOn;
  if ($("k-search").open) renderAccounts();
}

// ---------- Lys ----------

const all = (type) => [...byId.values()].filter((r) => r.type === type);
const serviceOf = (res, rtype) => {
  const s = (res?.services ?? []).find((x) => x.rtype === rtype);
  return s ? byId.get(s.rid) : undefined;
};

function lightRoomView(room) {
  const gl = serviceOf(room, "grouped_light");
  const on = Boolean(gl?.on?.on);
  const scenes = all("scene")
    .filter((s) => s.group?.rid === room.id)
    .map((s) => ({ id: s.id, name: s.metadata?.name ?? "Scene", active: Boolean(s.status?.active && s.status.active !== "inactive") }))
    .sort((a, b) => collator.compare(a.name, b.name))
    .slice(0, 4);
  return { id: room.id, name: room.metadata?.name ?? "Rom", glId: gl?.id, on, dim: on ? Math.round(gl?.dimming?.brightness ?? 0) : 0, scenes };
}

const lightEls = new Map(); // rom-id -> { el, refs }
const sendBrightness = new Map(); // grouped_light-id -> strupt funksjon

function createLightEl(id) {
  const name = h("strong");
  const status = h("span");
  const sw = h("button", { type: "button", class: "k-switch" });
  const sliderId = `k-dim-${id}`;
  const slider = h("input", { id: sliderId, type: "range", min: 1, max: 100, step: 1, "aria-label": "Lysstyrke" });
  const scenes = h("div", { class: "k-scenes" });
  const el = h("article", { class: "k-card k-light" }, h("div", { class: "k-light-head" }, h("div", {}, name, status), sw), slider, scenes);
  const refs = { name, status, sw, slider, scenes, view: null };
  sw.addEventListener("click", () => {
    const v = refs.view;
    if (!v?.glId) return;
    api("PUT", `/api/grouped_light/${v.glId}`, { on: !v.on });
  });
  slider.addEventListener("pointerdown", () => holding.set(slider, Infinity));
  const release = () => holding.set(slider, Date.now() + 2500);
  slider.addEventListener("pointerup", release);
  slider.addEventListener("pointercancel", release);
  slider.addEventListener("input", () => {
    const v = refs.view;
    if (!v?.glId) return;
    if (holding.get(slider) !== Infinity) holding.set(slider, Date.now() + 2500);
    setFill(slider);
    if (!sendBrightness.has(v.glId)) {
      const glId = v.glId;
      sendBrightness.set(glId, throttled(250, (b) => api("PUT", `/api/grouped_light/${glId}`, { brightness: b })));
    }
    sendBrightness.get(v.glId)(Number(slider.value));
  });
  return { el, refs };
}

function updateLightEl({ el, refs }, v) {
  refs.view = v;
  refs.name.textContent = v.name;
  refs.status.textContent = v.on ? `På · ${v.dim} %` : "Av";
  refs.sw.setAttribute("aria-pressed", String(v.on));
  refs.sw.setAttribute("aria-label", `${v.name}: ${v.on ? "skru av" : "skru på"}`);
  el.classList.toggle("on", v.on);
  const until = holding.get(refs.slider);
  if (until === undefined || (until !== Infinity && Date.now() > until)) {
    holding.delete(refs.slider);
    refs.slider.value = String(v.on ? v.dim : 1);
    setFill(refs.slider);
  }
  refs.slider.setAttribute("aria-label", `Lysstyrke i ${v.name}`);
  const key = JSON.stringify(v.scenes);
  if (refs.scenes.dataset.key !== key) {
    refs.scenes.dataset.key = key;
    refs.scenes.replaceChildren(
      ...v.scenes.map((s) =>
        h("button", { type: "button", "aria-pressed": String(s.active), onclick: () => api("POST", `/api/scene/${s.id}/recall`) }, s.name),
      ),
      h("button", { type: "button", onclick: () => v.glId && api("PUT", `/api/grouped_light/${v.glId}`, { on: false }) }, "Av"),
    );
  }
}

function renderLights() {
  const grid = $("k-light-grid");
  const rooms = all("room")
    .map(lightRoomView)
    .filter((v) => v.glId)
    .sort((a, b) => collator.compare(a.name, b.name));
  const hint = $("k-lys-hint");
  hint.hidden = rooms.length > 0;
  hint.textContent = online ? "Fant ingen rom med lys. Sjekk at Hue-broen er tilkoblet." : "Venter på kontakt med serveren …";
  const ids = rooms.map((r) => r.id);
  for (const [id, entry] of lightEls) {
    if (!ids.includes(id)) {
      entry.el.remove();
      lightEls.delete(id);
    }
  }
  rooms.forEach((v, i) => {
    if (!lightEls.has(v.id)) lightEls.set(v.id, createLightEl(v.id));
    const entry = lightEls.get(v.id);
    updateLightEl(entry, v);
    if (grid.children[i] !== entry.el) grid.insertBefore(entry.el, grid.children[i] ?? null);
  });
}

$("k-all-off").addEventListener("click", () => {
  if (confirm("Skru av alt lys i huset?")) api("POST", "/api/all-off");
});

// ---------- Dørklokke ----------

const RING_SHOW_MS = 3 * 60 * 1000;

function latestRing() {
  let best = null;
  for (const b of all("bell_button")) {
    const t = b.button?.button_report?.updated;
    if (t && (!best || t > best.time)) best = { time: t, res: b };
  }
  return best;
}

const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();

function renderBell() {
  const ring = latestRing();
  const today = ring && isToday(ring.time);
  const text = today ? `Ringte på kl. ${shortTime.format(new Date(ring.time))}` : "Ingen har ringt på i dag";
  $("k-bell-chip-text").textContent = text;
  $("k-bell-chip").classList.toggle("rang", Boolean(today));
  syncChips();
  $("k-bell-title").textContent = all("bell_button").length ? text : "Fant ingen dørklokke";
  document.querySelector(".k-bell-card").classList.toggle("rang", Boolean(today));
  const details = [];
  if (ring && !today) details.push(`Sist: ${new Date(ring.time).toLocaleString("nb-NO", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`);
  const cam = ring && all("camera_motion").find((c) => c.owner?.rid === ring.res.owner?.rid);
  if (cam) details.push(cam.motion?.motion ? "Bevegelse ved døra nå" : "Ingen bevegelse ved døra nå");
  $("k-bell-detail").textContent = details.join(" · ");
}

let audio = null;
// Nettlesere spiller bare lyd etter at noen har rørt skjermen. Lyden gjøres klar ved første trykk.
document.addEventListener(
  "pointerdown",
  () => {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch {
      audio = null;
    }
  },
  { once: false, passive: true },
);

function chime() {
  if (!audio || audio.state !== "running") return;
  const now = audio.currentTime;
  for (const [freq, at] of [
    [784, 0],
    [659, 0.45],
    [784, 1.3],
    [659, 1.75],
  ]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + at);
    gain.gain.linearRampToValueAtTime(0.35, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + at + 0.9);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + at);
    osc.stop(now + at + 1);
  }
}

let ringTimer = null;
function showRing(time) {
  const el = $("k-ring");
  $("k-ring-detail").textContent = `kl. ${shortTime.format(new Date(time))} · se hvem det er i Hue-appen`;
  el.hidden = false;
  $("k-ring-close").focus();
  chime();
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => (el.hidden = true), RING_SHOW_MS);
}
$("k-ring-close").addEventListener("click", () => {
  $("k-ring").hidden = true;
  clearTimeout(ringTimer);
});

// ---------- Samlet tegning og kontakt med serveren ----------

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    $("k-offline").hidden = online;
    renderMusic();
    renderLights();
    renderBell();
    renderTimerRooms();
  });
}

function applyEvent(ev) {
  for (const r of ev.data) {
    if (ev.type === "delete") byId.delete(r.id);
    else if (ev.type === "add" || !byId.has(r.id)) byId.set(r.id, structuredClone(r));
    else deepMerge(byId.get(r.id), r);
  }
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && t && typeof t === "object" && !Array.isArray(t)) deepMerge(t, v);
    else target[k] = structuredClone(v);
  }
}

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    online = true;
    render();
  });
  es.addEventListener("error", () => {
    online = false;
    render();
  });
  es.addEventListener("snapshot", (e) => {
    const snap = JSON.parse(e.data);
    byId.clear();
    for (const r of snap.resources ?? []) byId.set(r.id, r);
    sonos = snap.sonos ?? null;
    sonosAt = Date.now();
    spotifyOn = Boolean(snap.spotify);
    online = true;
    setTimers(snap.timers ?? []);
    render();
  });
  es.addEventListener("timers", (e) => setTimers(JSON.parse(e.data)));
  es.addEventListener("sonos", (e) => {
    sonos = JSON.parse(e.data);
    sonosAt = Date.now();
    render();
  });
  es.addEventListener("hue", (e) => {
    const events = JSON.parse(e.data);
    let rang = null;
    for (const ev of events) {
      applyEvent(ev);
      for (const r of ev.data) {
        if (r.type === "bell_button" && r.button?.button_report?.event === "initial_press") rang = r.button.button_report.updated;
      }
    }
    render();
    if (rang) showRing(rang);
  });
}

// Fullskjerm. Chrome tar bare hensyn til «display: fullscreen» i manifestet når siden går over https,
// så på hjemmenettet bes det om fullskjerm ved første trykk i stedet. Det tas igjen etter omlasting.
document.addEventListener(
  "pointerup",
  () => {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return;
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  },
  { passive: true },
);

// Fullskjerm legger siden øverst. Var et vindu (som søket) åpnet i samme trykk, havner det under siden og
// blir usynlig. Det åpnes derfor på nytt, så det kommer øverst igjen.
document.addEventListener("fullscreenchange", () => {
  for (const d of document.querySelectorAll("dialog[open]")) {
    const focused = document.activeElement;
    d.close();
    d.showModal();
    if (focused && d.contains(focused)) focused.focus();
  }
});

connect();
// Teksten om dørklokka skifter ved midnatt, og «Kobles til …» går ut på tid.
setInterval(render, 30_000);

// ---------- I dag: været fra yr ----------

function renderIdagTab() {
  const tabBtn = $("tab-idag");
  const had = !tabBtn.hidden;
  tabBtn.hidden = !weather?.configured && !waste?.configured;
  // Fanen kommer først når serveren har svart. Vis den lagrede fanen da.
  if (!had && !tabBtn.hidden && storage("kTab") === "idag" && tab !== "idag") showTab("idag", false);
  if (had && tabBtn.hidden && tab === "idag") showTab("musikk", false);
}

function renderWeather() {
  const w = weather;
  renderIdagTab();
  $("k-wx-now").hidden = !w?.configured;

  // Fanen viser været nå, slik at temperaturen alltid står øverst.
  if (w?.now) {
    $("k-idag-icon").innerHTML = Weather.icon(w.now.symbol, 28);
    $("k-idag-temp").textContent = Weather.temp(w.now.temp);
    $("tab-idag").setAttribute("aria-label", `I dag, ${Weather.temp(w.now.temp)} og ${w.now.text.toLowerCase()}`);
  } else {
    $("k-idag-temp").textContent = "";
    $("tab-idag").removeAttribute("aria-label");
  }
  if (!w?.configured) return;

  $("k-wx-place").textContent = w.place ? ` i ${w.place}` : "";
  const hint = $("k-wx-hint");
  hint.hidden = Boolean(w.available);
  hint.textContent = w.reason ?? "";
  const body = $("k-wx-now-body");
  if (!w.now) {
    body.replaceChildren();
    $("k-wx-hours").replaceChildren();
    $("k-wx-days").replaceChildren();
    return;
  }
  const n = w.now;
  const icon = h("div", { class: "k-wx-big" });
  icon.innerHTML = Weather.icon(n.symbol, 120);
  const facts = [`Vind ${n.wind.toLocaleString("nb-NO")} m/s${n.gust ? ` (kast ${Math.round(n.gust)})` : ""}`, n.precip >= 0.1 ? `${Weather.mm(n.precip)} neste time` : ""].filter(Boolean);
  body.replaceChildren(
    h("div", { class: "k-wx-now-top" }, icon, h("div", { class: "k-wx-now-text" }, h("strong", { class: "k-wx-temp" + (n.temp < 0 ? " cold" : "") }, Weather.temp(n.temp)), h("span", { class: "k-wx-desc" }, n.text))),
    w.note ? h("p", { class: "k-wx-note" }, w.note) : null,
    h("p", { class: "k-wx-facts" }, facts.join(" · ")),
  );

  $("k-wx-hours").replaceChildren(
    ...w.hours.slice(0, 12).map((x, i) => {
      const li = h("li", {}, h("span", { class: "k-wx-h" }, i === 0 ? "Nå" : Weather.hour(x.time)));
      li.insertAdjacentHTML("beforeend", Weather.icon(x.symbol, 40));
      li.append(h("strong", { class: x.temp < 0 ? "cold" : "" }, Weather.temp(x.temp)), h("span", { class: "k-wx-mm" }, Weather.mm(x.precip)));
      return li;
    }),
  );

  $("k-wx-days").replaceChildren(
    ...w.days.map((d) => {
      const li = h("li", {}, h("span", { class: "k-wx-day" }, Weather.dayName(d.date)));
      li.insertAdjacentHTML("beforeend", Weather.icon(d.symbol, 36));
      li.append(
        h("span", { class: "k-wx-range" }, h("strong", { class: d.max < 0 ? "cold" : "" }, Weather.temp(d.max)), h("span", {}, ` / ${Weather.temp(d.min)}`)),
        h("span", { class: "k-wx-mm" }, Weather.mm(d.precip)),
      );
      return li;
    }),
  );
}

async function loadWeather() {
  try {
    const res = await fetch("/api/weather");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    weather = await res.json();
  } catch {
    // Beholder det vi har. Mangler kontakt, vises det allerede øverst.
  }
  renderWeather();
}

// ---------- I dag: tømmekalenderen ----------

/**
 * Øverst til høyre er det plass til to merker. Tømming i dag eller i morgen vises der. Har ingen ringt på,
 * viker «Ingen har ringt på i dag» for tømmingen. Har noen ringt på, vises tømmingen kortere.
 */
function syncChips() {
  const chip = $("k-bin-chip");
  const soon = Waste.soon(waste?.pickups);
  const bell = $("k-bell-chip");
  const rang = bell.classList.contains("rang");
  chip.hidden = !soon;
  bell.hidden = Boolean(soon) && !rang;
  const shown = [chip, bell, $("k-timer-chip")].filter((c) => !c.hidden).length;
  document.querySelector(".k-top").classList.toggle("crowded", shown > 2);
  // Med to merker blir ringingen kortere: bare klokkeslettet.
  const ring = latestRing();
  if (rang && ring) $("k-bell-chip-text").textContent = soon ? `kl. ${shortTime.format(new Date(ring.time))}` : `Ringte på kl. ${shortTime.format(new Date(ring.time))}`;
  if (!soon) return;
  // En timer som går, tar også plass, så da blir tømmingen kort.
  const compact = rang || timers.length > 0;
  const when = soon.when === "i dag" ? "I dag" : "I morgen";
  chip.innerHTML = Waste.BIN_SVG;
  if (compact) {
    const dots = h("span", { class: "k-bin-dots" }, soon.types.map((t) => {
      const d = h("span", { class: "k-bin-dot" });
      d.style.setProperty("--bin", Waste.type(t).color);
      return d;
    }));
    chip.append(dots, h("span", {}, when));
  } else chip.append(h("span", {}, `${Waste.list(soon.types)} ${soon.when}`));
  chip.classList.toggle("today", soon.when === "i dag");
  chip.setAttribute("aria-label", `${Waste.list(soon.types)} hentes ${soon.when}. Vis tømmekalenderen`);
}

function binChips(types) {
  return types.map((t) => {
    const w = Waste.type(t);
    const el = h("span", { class: "k-bin-type" }, h("span", { class: "k-bin-dot" }), w.name);
    el.style.setProperty("--bin", w.color);
    return el;
  });
}

function renderWaste() {
  const w = waste;
  renderIdagTab();
  const card = $("k-bins");
  card.hidden = !w?.configured;
  const pickups = w?.pickups ?? [];

  syncChips();
  if (!w?.configured) return;

  const hint = $("k-bins-hint");
  hint.hidden = Boolean(pickups.length);
  hint.textContent = w.reason ?? "";
  const [next, ...rest] = pickups;
  $("k-bins-body").replaceChildren(
    ...(next
      ? [
          h("div", { class: "k-bin-next" }, h("strong", {}, Waste.day(next.date)), h("div", { class: "k-bin-types" }, binChips(next.types))),
          h(
            "ol",
            { class: "k-bin-list" },
            rest.slice(0, 3).map((p) => h("li", {}, h("span", { class: "k-bin-when" }, Waste.day(p.date)), h("div", { class: "k-bin-types" }, binChips(p.types)))),
          ),
        ]
      : []),
  );
}

async function loadWaste() {
  try {
    const res = await fetch("/api/waste");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    waste = await res.json();
  } catch {
    // Beholder det vi har.
  }
  renderWaste();
}

function loadIdag() {
  loadWeather();
  loadWaste();
}

$("k-bin-chip").addEventListener("click", () => showTab("idag"));
loadIdag();
setInterval(loadIdag, 10 * 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadIdag();
});

// ---------- Timer ----------
// Timerne går på serveren. Her vises de, og her startes og stoppes de. Når en timer er ferdig, dekker
// et varsel hele skjermen og piper til noen trykker Stopp. Serveren blinker lyset i rommet som ble valgt.

let alarmShown = null; // id-en til timeren varselet gjelder
let beepTimer = null;

function setTimers(list) {
  timers = Array.isArray(list) ? list : [];
  renderTimers();
}

function renderTimerChip() {
  const chip = $("k-timer-chip");
  const ringing = timers.filter((t) => t.ringing);
  const running = timers.filter((t) => !t.ringing);
  chip.innerHTML = Timer.ICON;
  chip.classList.toggle("ringing", ringing.length > 0);
  chip.classList.toggle("idle", !timers.length);
  if (ringing.length) {
    chip.append(h("span", {}, "Ferdig!"));
    chip.setAttribute("aria-label", "En timer er ferdig");
  } else if (running.length) {
    const next = running[0];
    chip.append(h("span", {}, Timer.clock(Timer.left(next)) + (running.length > 1 ? ` +${running.length - 1}` : "")));
    chip.setAttribute("aria-label", `${Timer.name(next)}: ${Timer.clock(Timer.left(next))} igjen. Åpne timere`);
  } else {
    chip.setAttribute("aria-label", "Start en timer");
  }
  // Timeren tar plass fra de andre merkene, så de tegnes på nytt når den starter eller stopper.
  if (chip.dataset.busy !== String(timers.length > 0)) {
    chip.dataset.busy = String(timers.length > 0);
    syncChips();
  }
}

function renderTimerList() {
  const list = $("k-timer-list");
  list.replaceChildren(
    ...timers.map((t) =>
      h(
        "div",
        { class: t.ringing ? "k-timer-row ringing" : "k-timer-row", "data-id": t.id },
        h("div", {}, h("strong", {}, Timer.name(t)), h("span", {}, t.roomName ? `Blinker i ${t.roomName}` : "Uten blinking")),
        h("span", { class: "k-timer-left" }, t.ringing ? "Ferdig" : Timer.clock(Timer.left(t))),
        h("button", { type: "button", onclick: () => api("POST", `/api/timers/${t.id}/extend`, { seconds: 60 }) }, "+1 min"),
        h("button", { type: "button", class: "stop", onclick: () => api("DELETE", `/api/timers/${t.id}`) }, t.ringing ? "Stopp" : "Avbryt"),
      ),
    ),
  );
}

let timerRoomsKey = "";
function renderTimerRooms() {
  const list = Timer.rooms(byId);
  const chosen = Timer.pickRoom(list, storage("kTimerRoom"));
  const key = JSON.stringify([chosen, list.map((r) => [r.id, r.metadata?.name])]);
  if (key === timerRoomsKey) return;
  timerRoomsKey = key;
  const pick = (id) => {
    storage("kTimerRoom", id);
    renderTimerRooms();
  };
  $("k-timer-rooms").replaceChildren(
    h("button", { type: "button", "aria-pressed": String(chosen === ""), onclick: () => pick("") }, "Ingen"),
    ...list.map((r) => h("button", { type: "button", "aria-pressed": String(chosen === r.id), onclick: () => pick(r.id) }, r.metadata?.name ?? "Rom")),
  );
}

function renderAlarm() {
  const ringing = timers.find((t) => t.ringing);
  const el = $("k-alarm");
  if (!ringing) {
    el.hidden = true;
    alarmShown = null;
    clearInterval(beepTimer);
    beepTimer = null;
    return;
  }
  $("k-alarm-title").textContent = ringing.label ? `${ringing.label} er ferdig` : "Timeren er ferdig";
  $("k-alarm-detail").textContent = [Timer.duration(ringing.durationMs), ringing.roomName ? `lyset blinker i ${ringing.roomName}` : ""].filter(Boolean).join(" · ");
  if (alarmShown !== ringing.id) {
    alarmShown = ringing.id;
    el.hidden = false;
    if ($("k-timer").open) $("k-timer").close();
    $("k-alarm-stop").focus();
  }
  if (!beepTimer) {
    Timer.beep(audio);
    beepTimer = setInterval(() => Timer.beep(audio), 2500);
  }
}

function renderTimers() {
  renderTimerChip();
  if ($("k-timer").open) renderTimerList();
  renderAlarm();
}

async function startTimer(minutes) {
  const list = Timer.rooms(byId);
  const room = Timer.pickRoom(list, storage("kTimerRoom"));
  const label = $("k-timer-name").value.trim();
  const t = await api("POST", "/api/timers", { seconds: Math.round(minutes * 60), label, room: room || undefined });
  if (!t) return;
  $("k-timer-name").value = "";
  $("k-timer").close();
  toast(`${Timer.name(t)} startet${t.roomName ? `, lyset blinker i ${t.roomName}` : ""}`);
}

$("k-timer-presets").replaceChildren(...Timer.PRESETS.map((m) => h("button", { type: "button", onclick: () => startTimer(m) }, m === 60 ? "1 time" : `${m} min`)));
$("k-timer-custom").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = Number($("k-timer-min").value);
  if (m > 0) {
    startTimer(m);
    $("k-timer-min").value = "";
  }
});
$("k-timer-chip").addEventListener("click", () => {
  if (timers.some((t) => t.ringing)) {
    alarmShown = null;
    renderAlarm();
    return;
  }
  renderTimerRooms();
  renderTimerList();
  $("k-timer").showModal();
});
$("k-timer-close").addEventListener("click", () => $("k-timer").close());
$("k-timer").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$("k-alarm-stop").addEventListener("click", () => {
  const t = timers.find((x) => x.id === alarmShown);
  if (t) api("DELETE", `/api/timers/${t.id}`);
});
$("k-alarm-more").addEventListener("click", () => {
  const t = timers.find((x) => x.id === alarmShown);
  if (t) api("POST", `/api/timers/${t.id}/extend`, { seconds: 60 });
});
// Nedtellingen oppdateres hvert sekund mens en timer går.
setInterval(() => {
  if (!timers.length) return;
  renderTimerChip();
  if ($("k-timer").open) {
    for (const row of document.querySelectorAll("#k-timer-list .k-timer-row:not(.ringing)")) {
      const t = timers.find((x) => x.id === row.dataset.id);
      if (t) row.querySelector(".k-timer-left").textContent = Timer.clock(Timer.left(t));
    }
  }
}, 1000);
renderTimerChip();
