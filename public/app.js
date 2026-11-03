// Hue-dashbord: holder en kopi av broens tilstand i nettleseren og oppdaterer den fra serverens hendelsesstrøm.

const byId = new Map();
let bridge = { connected: false, reason: "" };
let serverOnline = false;
let filter = "all";
const eventItems = []; // { time, text, kind }, nyeste først
const MAX_EVENTS = 100;
const BELL_WINDOW_MS = 30 * 60 * 1000;

// ---------- Hjelpere ----------

/** Lager et element. Tekst settes alltid som tekst, aldri som HTML, siden navn kommer fra broen. */
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

const timeFmt = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : "");
const collator = new Intl.Collator("nb");

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && t && typeof t === "object" && !Array.isArray(t)) deepMerge(t, v);
    else target[k] = v;
  }
}

function applyEvent(ev) {
  for (const r of ev.data) {
    if (ev.type === "delete") byId.delete(r.id);
    else if (ev.type === "add" || !byId.has(r.id)) byId.set(r.id, structuredClone(r));
    else deepMerge(byId.get(r.id), structuredClone(r));
  }
}

const all = (type) => [...byId.values()].filter((r) => r.type === type);
const serviceOf = (res, rtype) => {
  const s = (res?.services ?? []).find((x) => x.rtype === rtype);
  return s ? byId.get(s.rid) : undefined;
};

function nameOf(res) {
  if (!res) return "Ukjent";
  if (res.metadata?.name) return res.metadata.name;
  const owner = res.owner ? byId.get(res.owner.rid) : undefined;
  const ownerName = owner?.metadata?.name ?? "Ukjent enhet";
  if (res.type === "button" && res.metadata?.control_id) return `${ownerName}, knapp ${res.metadata.control_id}`;
  return ownerName;
}

// ---------- Farger: Hue sine xy- og mirek-verdier til en farge vi kan vise ----------

function xyToRgb(x, y) {
  const Y = 1, X = (Y / y) * x, Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b, 1e-6);
  [r, g, b] = [r, g, b].map((v) => {
    v = Math.max(0, v / max);
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, v) * 255);
  });
  return `rgb(${r}, ${g}, ${b})`;
}

function mirekToRgb(mirek) {
  const t = 1e6 / mirek / 100;
  const r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const c = (v) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

function lightColor(light) {
  const ct = light.color_temperature;
  if (ct?.mirek_valid && ct.mirek) return mirekToRgb(ct.mirek);
  if (light.color?.xy) return xyToRgb(light.color.xy.x, light.color.xy.y);
  return "#FFE3A3";
}

// ---------- Beregnet visning ----------

function roomLights(room) {
  const lights = [];
  for (const child of room.children ?? []) {
    const dev = byId.get(child.rid);
    if (!dev) continue;
    if (dev.type === "light") lights.push(dev);
    for (const s of dev.services ?? []) if (s.rtype === "light" && byId.get(s.rid)) lights.push(byId.get(s.rid));
  }
  return lights;
}

function roomView(room) {
  const gl = serviceOf(room, "grouped_light");
  const lights = roomLights(room);
  const on = Boolean(gl?.on?.on);
  const dim = on ? Math.round(gl?.dimming?.brightness ?? 0) : 0;
  const lit = lights.filter((l) => l.on?.on).sort((a, b) => (b.dimming?.brightness ?? 0) - (a.dimming?.brightness ?? 0));
  const scenes = all("scene")
    .filter((s) => s.group?.rid === room.id)
    .map((s) => ({ id: s.id, name: s.metadata?.name ?? "Scene", active: s.status?.active && s.status.active !== "inactive" }))
    .sort((a, b) => Number(b.active) - Number(a.active) || collator.compare(a.name, b.name))
    .slice(0, 4);
  return {
    id: room.id,
    name: room.metadata?.name ?? "Rom",
    glId: gl?.id,
    on,
    dim,
    lightCount: lights.length,
    litCount: lit.length,
    tint: lit[0] ? lightColor(lit[0]) : null,
    scenes,
  };
}

// ---------- Beskrivelse av hendelser ----------

function describe(r, ev) {
  const res = byId.get(r.id) ?? r;
  const name = nameOf(res);
  switch (r.type) {
    case "light":
      if (r.on) return { text: `${name} slått ${r.on.on ? "på" : "av"}` };
      return null;
    case "bell_button":
      if (r.button?.button_report?.event === "initial_press") return { text: "Det ringte på døra", kind: "bell-ev" };
      return null;
    case "button": {
      const e = r.button?.button_report?.event;
      if (e === "short_release") return { text: `${name}: kort trykk` };
      if (e === "long_press") return { text: `${name}: langt trykk` };
      return null;
    }
    case "relative_rotary":
      return r.relative_rotary?.rotary_report?.action === "start" ? { text: `${name}: dreid` } : null;
    case "camera_motion":
    case "motion": {
      const m = r.motion?.motion_report?.motion ?? r.motion?.motion;
      if (m === undefined) return null;
      const who = r.type === "camera_motion" ? `${name} (kamera)` : name;
      return { text: m ? `${who}: bevegelse` : `${who}: bevegelse stoppet` };
    }
    case "contact": {
      const st = r.contact_report?.state;
      if (!st) return null;
      return { text: `${name} ${st === "contact" ? "lukket" : "åpnet"}`, kind: st === "contact" ? "" : "warn" };
    }
    case "speaker": {
      const sound = r.chime?.status?.sound;
      return sound && sound !== "no_sound" ? { text: `${name} spilte ringelyd` } : null;
    }
    case "device_power": {
      const p = r.power_state;
      if (!p || p.battery_state === "normal" || !p.battery_state) return null;
      return { text: `${name}: batteri ${p.battery_state === "critical" ? "kritisk" : "lavt"} (${p.battery_level} %)`, kind: "warn" };
    }
    case "zigbee_connectivity":
      if (!r.status) return null;
      return r.status === "connected"
        ? { text: `${name} svarer igjen` }
        : { text: `${name} svarer ikke`, kind: "warn" };
    case "scene":
      if (r.status?.active && r.status.active !== "inactive") return { text: `Scene «${name}» aktivert` };
      return null;
    default:
      return null;
  }
}

function addEvents(events, isNew) {
  for (const ev of events) {
    for (const r of ev.data) {
      const d = describe(r, ev);
      if (d) eventItems.unshift({ time: ev.creationtime, isNew, ...d });
    }
  }
  eventItems.splice(MAX_EVENTS);
}

// ---------- Tegning ----------

const roomEls = new Map(); // rom-id -> { el, refs }
const dragging = new Set(); // rom-id som brukeren drar i lysstyrken på nå

function createRoomEl(id) {
  const swatch = h("span", { class: "swatch", "aria-hidden": "true" });
  const title = h("h3");
  const toggle = h("button", { type: "button", class: "toggle" });
  const meta = h("span", { class: "meta" });
  const slider = h("input", { type: "range", class: "dim", min: 1, max: 100, step: 1 });
  const scenes = h("div", { class: "scenes" });
  const el = h("article", { class: "room" }, h("div", { class: "room-head" }, swatch, title, toggle), meta, slider, scenes);

  toggle.addEventListener("click", () => {
    const v = roomView(byId.get(id));
    if (!v.glId) return;
    const gl = byId.get(v.glId);
    gl.on = { on: !v.on };
    scheduleRender();
    api("PUT", `/api/grouped_light/${v.glId}`, { on: !v.on });
  });

  let lastSend = 0;
  let pendingTimer = null;
  const sendBrightness = () => {
    const v = roomView(byId.get(id));
    if (!v.glId) return;
    lastSend = Date.now();
    api("PUT", `/api/grouped_light/${v.glId}`, { brightness: Number(slider.value) });
  };
  slider.addEventListener("pointerdown", () => dragging.add(id));
  slider.addEventListener("pointerup", () => dragging.delete(id));
  slider.addEventListener("input", () => {
    const v = roomView(byId.get(id));
    if (!v.glId) return;
    const gl = byId.get(v.glId);
    gl.on = { on: true };
    gl.dimming = { ...(gl.dimming ?? {}), brightness: Number(slider.value) };
    slider.style.setProperty("--fill", `${slider.value}%`);
    clearTimeout(pendingTimer);
    if (Date.now() - lastSend > 300) sendBrightness();
    else pendingTimer = setTimeout(sendBrightness, 300);
    scheduleRender();
  });
  slider.addEventListener("change", () => {
    dragging.delete(id);
    clearTimeout(pendingTimer);
    sendBrightness();
  });

  const entry = { el, refs: { swatch, title, toggle, meta, slider, scenes }, sceneKey: "" };
  roomEls.set(id, entry);
  return entry;
}

function updateRoomEl(entry, v) {
  const { swatch, title, toggle, meta, slider, scenes } = entry.refs;
  entry.el.classList.toggle("off", !v.on);
  swatch.style.background = v.on && v.tint ? v.tint : "";
  title.textContent = v.name;
  toggle.setAttribute("aria-pressed", String(v.on));
  toggle.setAttribute("aria-label", `${v.on ? "Slå av" : "Slå på"} ${v.name}`);
  meta.textContent = `${v.lightCount} lys · ${v.on ? `${v.dim} %` : "av"}`;
  slider.setAttribute("aria-label", `Lysstyrke ${v.name}`);
  if (!dragging.has(v.id)) {
    slider.value = String(v.on ? Math.max(1, v.dim) : 1);
    slider.style.setProperty("--fill", v.on ? `${v.dim}%` : "0%");
  }
  const key = v.scenes.map((s) => `${s.id}:${s.active}:${s.name}`).join("|");
  if (key !== entry.sceneKey) {
    entry.sceneKey = key;
    scenes.replaceChildren(
      ...v.scenes.map((s) =>
        h("button", {
          type: "button",
          class: s.active ? "scene active" : "scene",
          "aria-pressed": String(Boolean(s.active)),
          onclick: () => api("POST", `/api/scene/${s.id}/recall`),
        }, s.name),
      ),
    );
  }
}

function renderRooms() {
  const rooms = all("room").map(roomView).sort((a, b) => collator.compare(a.name, b.name));
  const shown = filter === "on" ? rooms.filter((r) => r.on) : rooms;
  const grid = document.getElementById("rooms");
  const els = shown.map((v) => {
    const entry = roomEls.get(v.id) ?? createRoomEl(v.id);
    updateRoomEl(entry, v);
    return entry.el;
  });
  // Bytter bare ut rekkefølgen når den faktisk har endret seg, slik at fokus og dra-bevegelser beholdes.
  const current = [...grid.children];
  if (current.length !== els.length || current.some((el, i) => el !== els[i])) grid.replaceChildren(...els);
  const zones = all("zone").length;
  document.getElementById("rooms-count").textContent = `${rooms.length} rom${zones ? ` · ${zones} soner` : ""}`;

  const lights = all("light");
  const onCount = lights.filter((l) => l.on?.on).length;
  document.getElementById("lights-on").textContent = `${onCount} av ${lights.length} lys på`;
}

function renderStatus() {
  const chip = document.getElementById("bridge-status");
  const ok = serverOnline && bridge.connected;
  chip.classList.toggle("offline", !ok);
  chip.lastElementChild.textContent = !serverOnline ? "Mistet kontakt med serveren" : bridge.connected ? "Broen tilkoblet" : "Mistet broen";
  const live = document.getElementById("live");
  live.classList.toggle("paused", !ok);
  live.lastChild.textContent = ok ? "Live" : "Pause";
}

function tile(label, value, sub, alert) {
  return h("div", { class: alert ? "tile alert" : "tile" }, h("span", { class: "label" }, label), h("strong", {}, value), sub ? h("span", { class: "sub" }, sub) : null);
}

function renderSecurity() {
  const tiles = [];
  for (const b of all("bell_button")) {
    const when = b.button?.button_report?.updated;
    tiles.push(tile(nameOf(b), "Dørklokke", when ? `Sist ringt ${fmtTime(when)}` : "Ikke ringt ennå"));
  }
  for (const c of all("camera_motion")) {
    const m = Boolean(c.motion?.motion);
    tiles.push(tile(`${nameOf(c)} (kamera)`, m ? "Bevegelse nå" : "Ingen bevegelse", c.motion?.motion_report?.changed ? `Endret ${fmtTime(c.motion.motion_report.changed)}` : "", m));
  }
  for (const c of all("contact")) {
    const open = c.contact_report?.state === "no_contact";
    tiles.push(tile(nameOf(c), open ? "Åpen" : "Lukket", c.contact_report?.changed ? `Endret ${fmtTime(c.contact_report.changed)}` : "", open));
  }
  for (const s of all("speaker")) {
    const playing = s.chime?.status?.sound && s.chime.status.sound !== "no_sound";
    tiles.push(tile(nameOf(s), playing ? "Ringer" : "Stille", "Ringeklokke inne", playing));
  }
  for (const m of all("motion").filter((x) => x.enabled)) {
    const on = Boolean(m.motion?.motion);
    tiles.push(tile(nameOf(m), on ? "Bevegelse nå" : "Ingen bevegelse", "Bevegelsessensor", on));
  }
  const box = document.getElementById("security");
  box.replaceChildren(...(tiles.length ? tiles : [h("p", { class: "empty" }, "Ingen sikkerhetsenheter funnet.")]));
}

function renderEvents() {
  const list = document.getElementById("events");
  if (!eventItems.length) {
    list.replaceChildren(h("li", { class: "empty" }, "Ingen hendelser ennå. Skru på et lys eller trykk på en bryter."));
    return;
  }
  list.replaceChildren(
    ...eventItems.map((e) => {
      const li = h("li", { class: [e.kind, e.isNew ? "new" : ""].filter(Boolean).join(" ") }, h("time", { datetime: e.time }, fmtTime(e.time)), h("span", { class: "text" }, e.text));
      e.isNew = false;
      return li;
    }),
  );
}

function renderHealth() {
  const batteries = all("device_power")
    .filter((p) => p.power_state && (p.power_state.battery_state !== "normal" || p.power_state.battery_level <= 15))
    .map((p) => ({ name: nameOf(p), level: p.power_state.battery_level, state: p.power_state.battery_state }))
    .sort((a, b) => a.level - b.level);
  const critical = batteries.filter((b) => b.state === "critical").length;
  const low = batteries.length - critical;
  const offline = all("zigbee_connectivity").filter((z) => z.status && z.status !== "connected").map(nameOf).sort(collator.compare);

  const badges = [];
  if (critical) badges.push(h("span", { class: "badge bad" }, `${critical} ${critical === 1 ? "batteri" : "batterier"} kritisk`));
  if (low) badges.push(h("span", { class: "badge warn" }, `${low} lave`));
  if (offline.length) badges.push(h("span", { class: "badge" }, `${offline.length} ${offline.length === 1 ? "enhet svarer" : "enheter svarer"} ikke`));

  const box = document.getElementById("health");
  if (!badges.length) {
    box.replaceChildren(h("p", { class: "empty" }, "Alt ser bra ut. Ingen lave batterier, og alle enheter svarer."));
    return;
  }
  box.replaceChildren(
    h("div", { class: "badges" }, badges),
    batteries.length ? h("ul", { class: "health-list" }, batteries.map((b) => h("li", {}, `${b.name} `, h("span", {}, `${b.level} %`)))) : null,
    offline.length ? h("details", {}, h("summary", {}, "Vis enheter som ikke svarer"), h("ul", { class: "health-list" }, offline.map((n) => h("li", {}, n)))) : null,
  );
}

// ---------- Ringebanner ----------

function latestRing() {
  let best = null;
  for (const b of all("bell_button")) {
    const t = b.button?.button_report?.updated;
    if (t && (!best || t > best.time)) best = { time: t, res: b };
  }
  return best;
}

function renderBell(ringingNow = false) {
  const el = document.getElementById("bell");
  const ring = latestRing();
  const dismissed = storage("bellDismissed");
  if (!ring || Date.now() - Date.parse(ring.time) > BELL_WINDOW_MS || dismissed === ring.time) {
    el.hidden = true;
    return;
  }
  const cam = all("camera_motion").find((c) => c.owner?.rid === ring.res.owner?.rid);
  const parts = [nameOf(ring.res)];
  if (cam) {
    const changed = cam.motion?.motion_report?.changed;
    parts.push(cam.motion?.motion ? "bevegelse ved døra nå" : `ingen bevegelse nå${changed ? ` (sist ${fmtTime(changed)})` : ""}`);
  }
  parts.push("live-bildet ser du i Hue-appen");
  document.getElementById("bell-title").textContent = `Det ringte på kl. ${fmtTime(ring.time).slice(0, 5)}`;
  document.getElementById("bell-detail").textContent = parts.join(" · ");
  el.dataset.time = ring.time;
  el.hidden = false;
  if (ringingNow) {
    el.classList.remove("ringing");
    void el.offsetWidth;
    el.classList.add("ringing");
    document.title = "Det ringer på! · Hue-dashbord";
    setTimeout(() => (document.title = "Hjemme · Hue-dashbord"), 30_000);
  }
}

// ---------- Samlet tegning ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderRooms();
    renderSecurity();
    renderEvents();
    renderHealth();
    renderStatus();
    renderBell();
  });
}

// ---------- Kontakt med serveren ----------

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  } catch (err) {
    console.error(err);
    eventItems.unshift({ time: new Date().toISOString(), text: `Kommandoen feilet: ${err.message}`, kind: "warn", isNew: true });
    scheduleRender();
  }
}

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    serverOnline = true;
    scheduleRender();
  });
  es.addEventListener("error", () => {
    serverOnline = false;
    scheduleRender();
  });
  es.addEventListener("snapshot", (e) => {
    const snap = JSON.parse(e.data);
    byId.clear();
    for (const r of snap.resources) byId.set(r.id, r);
    bridge = snap.bridge;
    eventItems.length = 0;
    addEvents(snap.recent ?? [], false);
    scheduleRender();
  });
  es.addEventListener("bridge", (e) => {
    bridge = JSON.parse(e.data);
    scheduleRender();
  });
  es.addEventListener("hue", (e) => {
    const events = JSON.parse(e.data);
    let rang = false;
    for (const ev of events) {
      applyEvent(ev);
      if (ev.data.some((r) => r.type === "bell_button" && r.button?.button_report?.event === "initial_press")) rang = true;
    }
    addEvents(events, true);
    scheduleRender();
    if (rang) requestAnimationFrame(() => renderBell(true));
  });
}

// ---------- Oppstart ----------

document.getElementById("bell-close").addEventListener("click", () => {
  const el = document.getElementById("bell");
  storage("bellDismissed", el.dataset.time ?? "");
  el.hidden = true;
});

document.getElementById("all-off").addEventListener("click", () => {
  if (confirm("Skru av alle lys i huset?")) api("POST", "/api/all-off");
});

for (const btn of document.querySelectorAll("[data-filter]")) {
  btn.addEventListener("click", () => {
    filter = btn.dataset.filter;
    storage("roomFilter", filter);
    for (const b of document.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b === btn));
    scheduleRender();
  });
}
const savedFilter = storage("roomFilter");
if (savedFilter === "on" || savedFilter === "all") document.querySelector(`[data-filter="${savedFilter}"]`)?.click();

const dateFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long" });
const clockFmt = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" });
function tick() {
  const now = new Date();
  document.getElementById("clock").textContent = `${dateFmt.format(now)} · ${clockFmt.format(now)}`;
}
tick();
setInterval(tick, 10_000);
// Banneret skjules av seg selv når ringingen er mer enn 30 minutter gammel.
setInterval(() => renderBell(), 60_000);

connect();
