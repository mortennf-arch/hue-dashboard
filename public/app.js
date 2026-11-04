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

/** Navnet appen viser for en lampe: enhetens navn når enheten bare har én lampe. */
function lightName(l) {
  const dev = byId.get(l?.owner?.rid);
  const lightsOnDev = (dev?.services ?? []).filter((s) => s.rtype === "light").length;
  if (dev?.metadata?.name && lightsOnDev === 1) return dev.metadata.name;
  return l?.metadata?.name ?? "Lampe";
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

function roomView(room, allScenes = false) {
  const gl = serviceOf(room, "grouped_light");
  const lights = roomLights(room);
  const on = Boolean(gl?.on?.on);
  const dim = on ? Math.round(gl?.dimming?.brightness ?? 0) : 0;
  const lit = lights.filter((l) => l.on?.on).sort((a, b) => (b.dimming?.brightness ?? 0) - (a.dimming?.brightness ?? 0));
  const scenes = all("scene")
    .filter((s) => s.group?.rid === room.id)
    .map((s) => ({ id: s.id, name: s.metadata?.name ?? "Scene", active: s.status?.active && s.status.active !== "inactive" }))
    .sort((a, b) => Number(b.active) - Number(a.active) || collator.compare(a.name, b.name))
    .slice(0, allScenes ? undefined : 4);
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
  const openBtn = h("button", { type: "button", class: "room-open", onclick: () => openDetail(id) });
  const title = h("h3", {}, openBtn);
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

  const entry = { el, refs: { swatch, title: openBtn, toggle, meta, slider, scenes }, sceneKey: "" };
  roomEls.set(id, entry);
  return entry;
}

function updateRoomEl(entry, v) {
  const { swatch, title, toggle, meta, slider, scenes } = entry.refs;
  entry.el.classList.toggle("off", !v.on);
  swatch.style.background = v.on && v.tint ? v.tint : "";
  title.textContent = v.name;
  title.setAttribute("aria-label", `Åpne ${v.name}`);
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

function fillGrid(grid, views) {
  const els = views.map((v) => {
    const entry = roomEls.get(v.id) ?? createRoomEl(v.id);
    updateRoomEl(entry, v);
    return entry.el;
  });
  // Bytter bare ut rekkefølgen når den faktisk har endret seg, slik at fokus og dra-bevegelser beholdes.
  const current = [...grid.children];
  if (current.length !== els.length || current.some((el, i) => el !== els[i])) grid.replaceChildren(...els);
}

function renderRooms() {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const rooms = all("room").map((r) => roomView(r)).sort(byName);
  const zones = all("zone").map((z) => roomView(z)).sort(byName);
  const pick = (list) => (filter === "on" ? list.filter((r) => r.on) : list);
  fillGrid(document.getElementById("rooms"), pick(rooms));
  const shownZones = pick(zones);
  fillGrid(document.getElementById("zones"), shownZones);
  document.getElementById("zones-head").hidden = shownZones.length === 0;
  document.getElementById("rooms-count").textContent = `${rooms.length} rom${zones.length ? ` · ${zones.length} soner` : ""}`;

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

// ---------- Detaljvisning for ett rom eller én sone ----------

let openGroupId = null;
const lightEls = new Map(); // lampe-id -> { el, refs }

/** Sender høyst én verdi per `ms`, og alltid den siste. */
function throttled(ms, fn) {
  let last = 0;
  let timer = null;
  let pending;
  return (value) => {
    pending = value;
    clearTimeout(timer);
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn(pending);
    } else {
      timer = setTimeout(() => {
        last = Date.now();
        fn(pending);
      }, wait);
    }
  };
}

function rgbToHex(rgb) {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return "#ffffff";
  return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

function hexToXy(hex) {
  const lin = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z || 1;
  return { x: X / sum, y: Y / sum };
}

function createLightEl(id) {
  const swatch = h("span", { class: "swatch", "aria-hidden": "true" });
  const name = h("span");
  const toggle = h("button", { type: "button", class: "toggle" });
  const dim = h("input", { type: "range", class: "dim", min: 1, max: 100, step: 1 });
  const dimField = h("label", {}, "Lysstyrke", dim);
  const color = h("input", { type: "color", class: "color" });
  const colorField = h("label", {}, "Farge", color);
  const ct = h("input", { type: "range", class: "ct", step: 1 });
  const ctField = h("label", { class: "ct-field" }, "Kaldt – varmt", ct);
  const note = h("span", { class: "note" });
  const el = h(
    "li",
    { class: "light" },
    h("div", { class: "light-name" }, swatch, name),
    toggle,
    h("div", { class: "light-controls" }, dimField, ctField, colorField),
    note,
  );
  const more = createLightMore(id);
  el.append(more.el);

  const local = () => byId.get(id);
  toggle.addEventListener("click", () => {
    const l = local();
    if (!l) return;
    const next = !l.on?.on;
    l.on = { on: next };
    scheduleRender();
    api("PUT", `/api/light/${id}`, { on: next });
  });

  const sendDim = throttled(200, (v) => api("PUT", `/api/light/${id}`, { brightness: v }));
  dim.addEventListener("pointerdown", () => dragging.add(id));
  dim.addEventListener("input", () => {
    const l = local();
    if (!l) return;
    l.on = { on: true };
    l.dimming = { ...(l.dimming ?? {}), brightness: Number(dim.value) };
    dim.style.setProperty("--fill", `${dim.value}%`);
    sendDim(Number(dim.value));
    scheduleRender();
  });
  dim.addEventListener("change", () => dragging.delete(id));

  const sendCt = throttled(200, (v) => api("PUT", `/api/light/${id}`, { mirek: v }));
  ct.addEventListener("pointerdown", () => dragging.add(id));
  ct.addEventListener("input", () => {
    const l = local();
    if (!l) return;
    l.on = { on: true };
    l.color_temperature = { ...(l.color_temperature ?? {}), mirek: Number(ct.value), mirek_valid: true };
    sendCt(Number(ct.value));
    scheduleRender();
  });
  ct.addEventListener("change", () => dragging.delete(id));

  const sendColor = throttled(200, (xy) => api("PUT", `/api/light/${id}`, { xy }));
  color.addEventListener("focus", () => dragging.add(id));
  color.addEventListener("blur", () => dragging.delete(id));
  color.addEventListener("input", () => {
    const l = local();
    if (!l) return;
    const xy = hexToXy(color.value);
    l.on = { on: true };
    l.color = { ...(l.color ?? {}), xy };
    if (l.color_temperature) l.color_temperature = { ...l.color_temperature, mirek_valid: false };
    sendColor(xy);
    scheduleRender();
  });

  const entry = { el, refs: { swatch, name, toggle, dim, dimField, color, colorField, ct, ctField, note }, more };
  lightEls.set(id, entry);
  return entry;
}

function updateLightEl(entry, l) {
  const { swatch, name, toggle, dim, dimField, color, colorField, ct, ctField, note } = entry.refs;
  const on = Boolean(l.on?.on);
  const label = lightName(l);
  const zb = serviceOf(byId.get(l.owner?.rid), "zigbee_connectivity");
  const unreachable = zb?.status && zb.status !== "connected";
  entry.el.classList.toggle("unreachable", Boolean(unreachable));
  note.textContent = unreachable ? "Svarer ikke. Er den skrudd av på veggbryteren?" : "";
  note.hidden = !unreachable;
  name.textContent = label;
  swatch.style.background = on ? lightColor(l) : "";
  toggle.setAttribute("aria-pressed", String(on));
  toggle.setAttribute("aria-label", `${on ? "Slå av" : "Slå på"} ${label}`);

  dimField.hidden = !l.dimming;
  dim.setAttribute("aria-label", `Lysstyrke ${label}`);
  const schema = l.color_temperature?.mirek_schema;
  ctField.hidden = !schema;
  colorField.hidden = !l.color;
  color.setAttribute("aria-label", `Farge ${label}`);
  ct.setAttribute("aria-label", `Hvittone ${label}`);
  updateLightMore(entry.more, l);
  if (dragging.has(l.id)) return;
  const b = Math.round(l.dimming?.brightness ?? 0);
  dim.value = String(on ? Math.max(1, b) : 1);
  dim.style.setProperty("--fill", on ? `${b}%` : "0%");
  if (schema) {
    ct.min = String(schema.mirek_minimum ?? 153);
    ct.max = String(schema.mirek_maximum ?? 500);
    ct.value = String(l.color_temperature.mirek ?? Math.round((Number(ct.min) + Number(ct.max)) / 2));
  }
  if (l.color) color.value = rgbToHex(lightColor(l));
}

function renderDetail() {
  const dlg = document.getElementById("detail");
  const group = openGroupId ? byId.get(openGroupId) : null;
  if (!group) {
    if (dlg.open) dlg.close();
    return;
  }
  const v = roomView(group, true);
  document.getElementById("detail-title").textContent = v.name;
  document.getElementById("detail-kind").textContent = group.type === "zone" ? "sonen" : "rommet";
  document.getElementById("detail-swatch").style.background = v.on && v.tint ? v.tint : "";
  const toggle = document.getElementById("detail-toggle");
  toggle.setAttribute("aria-pressed", String(v.on));
  toggle.setAttribute("aria-label", `${v.on ? "Slå av" : "Slå på"} ${v.name}`);
  const dim = document.getElementById("detail-dim");
  dim.setAttribute("aria-label", `Lysstyrke ${v.name}`);
  if (!dragging.has(`detail:${v.id}`)) {
    dim.value = String(v.on ? Math.max(1, v.dim) : 1);
    dim.style.setProperty("--fill", v.on ? `${v.dim}%` : "0%");
  }
  document.getElementById("detail-dim-out").textContent = v.on ? `${v.dim} %` : "av";

  const scenes = document.getElementById("detail-scenes");
  const key = v.scenes.map((s) => `${s.id}:${s.active}:${s.name}`).join("|");
  if (scenes.dataset.key !== key) {
    scenes.dataset.key = key;
    scenes.replaceChildren(
      ...(v.scenes.length
        ? v.scenes.map((s) =>
            h("button", { type: "button", class: s.active ? "scene active" : "scene", "aria-pressed": String(Boolean(s.active)), onclick: () => api("POST", `/api/scene/${s.id}/recall`) }, s.name),
          )
        : [h("span", { class: "empty" }, "Ingen scener.")]),
    );
  }

  const lights = roomLights(group).sort((a, b) => collator.compare(lightName(a), lightName(b)));
  const list = document.getElementById("detail-lights");
  const els = lights.map((l) => {
    const entry = lightEls.get(l.id) ?? createLightEl(l.id);
    updateLightEl(entry, l);
    return entry.el;
  });
  const current = [...list.children];
  if (current.length !== els.length || current.some((el, i) => el !== els[i])) list.replaceChildren(...els);
  renderDetailExtras(group, v);
}

function openDetail(id) {
  openGroupId = id;
  lightEls.clear();
  document.getElementById("detail-lights").replaceChildren();
  document.getElementById("detail-scenes").dataset.key = "";
  document.getElementById("scene-manage").open = false;
  document.getElementById("add-lights").open = false;
  document.getElementById("group-type").dataset.for = "";
  renderDetail();
  const dlg = document.getElementById("detail");
  if (!dlg.open) dlg.showModal();
}

{
  const dlg = document.getElementById("detail");
  dlg.addEventListener("close", () => {
    openGroupId = null;
    lightEls.clear();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close(); // klikk utenfor lukker
  });
  document.getElementById("detail-close").addEventListener("click", () => dlg.close());
  document.getElementById("detail-toggle").addEventListener("click", () => {
    const v = openGroupId && roomView(byId.get(openGroupId));
    if (!v?.glId) return;
    byId.get(v.glId).on = { on: !v.on };
    scheduleRender();
    api("PUT", `/api/grouped_light/${v.glId}`, { on: !v.on });
  });
  const dim = document.getElementById("detail-dim");
  const sendGroupDim = throttled(300, ({ glId, value }) => api("PUT", `/api/grouped_light/${glId}`, { brightness: value }));
  dim.addEventListener("pointerdown", () => openGroupId && dragging.add(`detail:${openGroupId}`));
  dim.addEventListener("input", () => {
    const v = openGroupId && roomView(byId.get(openGroupId));
    if (!v?.glId) return;
    const gl = byId.get(v.glId);
    gl.on = { on: true };
    gl.dimming = { ...(gl.dimming ?? {}), brightness: Number(dim.value) };
    dim.style.setProperty("--fill", `${dim.value}%`);
    sendGroupDim({ glId: v.glId, value: Number(dim.value) });
    scheduleRender();
  });
  dim.addEventListener("change", () => openGroupId && dragging.delete(`detail:${openGroupId}`));
}

// ---------- Administrasjon: det Hue-appen ellers gjør med rom, soner, scener og lamper ----------

const ARCHETYPES = [
  ["living_room", "Stue"], ["kitchen", "Kjøkken"], ["dining", "Spisestue"], ["bedroom", "Soverom"],
  ["kids_bedroom", "Barnerom"], ["nursery", "Babyrom"], ["guest_room", "Gjesterom"], ["bathroom", "Bad"],
  ["toilet", "Toalett"], ["office", "Kontor"], ["computer", "Datarom"], ["lounge", "Salong"],
  ["tv", "TV-stue"], ["reading", "Lesekrok"], ["recreation", "Hobbyrom"], ["gym", "Treningsrom"],
  ["music", "Musikkrom"], ["studio", "Studio"], ["man_cave", "Kjellerstue"], ["hallway", "Gang"],
  ["front_door", "Inngang"], ["staircase", "Trapp"], ["closet", "Garderobe"], ["storage", "Bod"],
  ["laundry_room", "Vaskerom"], ["attic", "Loft"], ["downstairs", "Nede"], ["upstairs", "Oppe"],
  ["top_floor", "Toppetasje"], ["home", "Hjem"], ["garage", "Garasje"], ["carport", "Carport"],
  ["driveway", "Innkjørsel"], ["garden", "Hage"], ["terrace", "Terrasse"], ["balcony", "Balkong"],
  ["porch", "Veranda"], ["barbecue", "Grill"], ["pool", "Basseng"], ["other", "Annet"],
];

const EFFECTS = {
  no_effect: "Ingen effekt", candle: "Stearinlys", fire: "Peis", prism: "Prisme", sparkle: "Glitter",
  opal: "Opal", glisten: "Glimt", underwater: "Under vann", cosmos: "Kosmos", sunbeam: "Solstråle", enchant: "Fortryllet",
};

const POWERUP = [
  ["safety", "Varmt hvitt, full styrke"],
  ["powerfail", "Som før strømmen gikk (også av)"],
  ["last_on_state", "På, med siste farge og styrke"],
];

function archetypeOptions(select, current) {
  const known = ARCHETYPES.some(([k]) => k === current);
  const opts = ARCHETYPES.map(([k, label]) => h("option", { value: k }, label));
  if (current && !known) opts.unshift(h("option", { value: current }, current));
  select.replaceChildren(...opts);
  select.value = current || "other";
}

const roomOfDevice = (devId) => all("room").find((r) => (r.children ?? []).some((c) => c.rid === devId));
const lightDevices = () => all("device").filter((d) => (d.services ?? []).some((s) => s.rtype === "light"));

/** Flytter enheter til et rom (eller ut av alle rom når targetId er null). En enhet kan bare være i ett rom. */
async function assignDevicesToRoom(deviceIds, targetId) {
  const moving = new Set(deviceIds);
  for (const room of all("room")) {
    if (room.id === targetId) continue;
    const kept = (room.children ?? []).filter((c) => !moving.has(c.rid));
    if (kept.length !== (room.children ?? []).length) await resource("PUT", "room", room.id, { children: kept });
  }
  if (!targetId) return;
  const target = byId.get(targetId);
  const children = [...(target.children ?? [])];
  for (const id of deviceIds) if (!children.some((c) => c.rid === id)) children.push({ rid: id, rtype: "device" });
  await resource("PUT", "room", targetId, { children });
}

/** Lyset slik det er nå, som scene-handlinger. */
function currentActions(group) {
  return roomLights(group).map((l) => {
    const on = Boolean(l.on?.on);
    const action = { on: { on } };
    if (on) {
      if (l.dimming) action.dimming = { brightness: Math.max(1, Math.round(l.dimming.brightness ?? 100)) };
      if (l.color_temperature?.mirek_valid && l.color_temperature.mirek) action.color_temperature = { mirek: l.color_temperature.mirek };
      else if (l.color?.xy) action.color = { xy: l.color.xy };
    }
    return { target: { rid: l.id, rtype: "light" }, action };
  });
}

const hasPalette = (scene) => Object.values(scene.palette ?? {}).some((v) => Array.isArray(v) && v.length);

// --- Mer-panelet for hver lampe ---

function createLightMore(id) {
  const local = () => byId.get(id);
  const nameIn = h("input", { type: "text", class: "text-in", maxlength: 32, "aria-label": "Nytt navn" });
  const nameForm = h("form", { class: "inline" }, nameIn, h("button", { type: "submit", class: "small" }, "Gi nytt navn"));
  nameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const l = local();
    const name = nameIn.value.trim();
    if (!l || !name) return;
    const dev = byId.get(l.owner?.rid);
    const single = (dev?.services ?? []).filter((s) => s.rtype === "light").length === 1;
    if (single) await resource("PUT", "device", dev.id, { metadata: { name } }).catch(() => {});
    else await resource("PUT", "light", id, { metadata: { name } }).catch(() => {});
  });

  const blink = h("button", { type: "button", class: "small" }, "Blink, så jeg finner den");
  blink.addEventListener("click", () => {
    const l = local();
    const dev = byId.get(l?.owner?.rid);
    if (dev) resource("PUT", "device", dev.id, { identify: { action: "identify" } }).catch(() => {});
    else resource("PUT", "light", id, { identify: { action: "identify" } }).catch(() => {});
  });

  const effect = h("select", { class: "text-in" });
  const effectField = h("label", { class: "field" }, h("span", {}, "Effekt"), effect);
  effect.addEventListener("change", () => {
    const l = local();
    if (!l) return;
    const body = l.effects_v2 ? { effects_v2: { action: { effect: effect.value } } } : { effects: { effect: effect.value } };
    if (effect.value !== "no_effect" && !l.on?.on) body.on = { on: true };
    resource("PUT", "light", id, body).catch(() => {});
  });

  const duration = h("select", { class: "text-in", "aria-label": "Varighet" },
    [5, 10, 15, 30, 45, 60].map((m) => h("option", { value: m }, `${m} min`)));
  duration.value = "15";
  const timed = (fx) => resource("PUT", "light", id, { timed_effects: fx === "no_effect" ? { effect: fx } : { effect: fx, duration: Number(duration.value) * 60_000 } }).catch(() => {});
  const timedStatus = h("span", { class: "muted" });
  const timedField = h("div", { class: "field" }, h("span", {}, "Soloppgang og solnedgang"),
    h("div", { class: "inline" }, duration,
      h("button", { type: "button", class: "small", onclick: () => timed("sunrise") }, "Soloppgang"),
      h("button", { type: "button", class: "small", onclick: () => timed("sunset") }, "Solnedgang"),
      h("button", { type: "button", class: "small", onclick: () => timed("no_effect") }, "Stopp"),
      timedStatus));

  const powerup = h("select", { class: "text-in" });
  const powerupField = h("label", { class: "field" }, h("span", {}, "Når strømmen kommer tilbake"), powerup);
  powerup.addEventListener("change", () => {
    if (powerup.value === "custom") return;
    resource("PUT", "light", id, { powerup: { preset: powerup.value } }).catch(() => {});
  });

  const move = h("select", { class: "text-in" });
  const moveField = h("label", { class: "field" }, h("span", {}, "Rom"), move);
  move.addEventListener("change", () => {
    const dev = byId.get(local()?.owner?.rid);
    if (!dev) return;
    const target = move.value || null;
    const targetName = target ? byId.get(target)?.metadata?.name : "uten rom";
    if (!confirm(`Flytte ${lightName(local())} til ${targetName}?`)) {
      move.dataset.key = "";
      return scheduleRender();
    }
    assignDevicesToRoom([dev.id], target).catch(() => {});
  });
  const unzone = h("button", { type: "button", class: "small danger" }, "Fjern fra sonen");
  unzone.addEventListener("click", () => {
    const zone = byId.get(openGroupId);
    if (!zone || zone.type !== "zone") return;
    const children = (zone.children ?? []).filter((c) => c.rid !== id);
    resource("PUT", "zone", zone.id, { children }).catch(() => {});
  });

  const body = h("div", { class: "more-body" },
    h("div", { class: "inline" }, nameForm, blink),
    h("div", { class: "more-grid" }, effectField, powerupField, moveField),
    timedField,
    h("div", { class: "inline" }, unzone));
  const el = h("details", { class: "more" }, h("summary", {}, "Mer"), body);
  el.addEventListener("toggle", () => el.open && scheduleRender());
  return { el, refs: { nameIn, effect, effectField, timedField, timedStatus, powerup, powerupField, move, moveField, unzone } };
}

function updateLightMore(more, l) {
  if (!more.el.open) return;
  const r = more.refs;
  const active = document.activeElement;
  if (active !== r.nameIn) r.nameIn.value = lightName(l);

  const values = l.effects_v2?.action?.effect_values ?? l.effects?.effect_values;
  r.effectField.hidden = !values?.length;
  if (values?.length && active !== r.effect) {
    const key = values.join(",");
    if (r.effect.dataset.key !== key) {
      r.effect.dataset.key = key;
      r.effect.replaceChildren(...values.map((v) => h("option", { value: v }, EFFECTS[v] ?? v)));
    }
    r.effect.value = l.effects_v2?.status?.effect ?? l.effects?.status ?? "no_effect";
  }

  const timed = l.timed_effects;
  r.timedField.hidden = !timed;
  r.timedStatus.textContent = timed?.status === "sunrise" ? "Soloppgang pågår" : timed?.status === "sunset" ? "Solnedgang pågår" : "";

  r.powerupField.hidden = !l.powerup;
  if (l.powerup && active !== r.powerup) {
    const opts = POWERUP.map(([k, label]) => h("option", { value: k }, label));
    if (l.powerup.preset === "custom") opts.push(h("option", { value: "custom" }, "Egendefinert (fra appen)"));
    r.powerup.replaceChildren(...opts);
    r.powerup.value = l.powerup.preset;
  }

  const group = byId.get(openGroupId);
  const inZone = group?.type === "zone";
  r.unzone.hidden = !inZone;
  const dev = byId.get(l.owner?.rid);
  r.moveField.hidden = !dev;
  if (dev && active !== r.move) {
    const rooms = all("room").sort((a, b) => collator.compare(a.metadata?.name ?? "", b.metadata?.name ?? ""));
    const current = roomOfDevice(dev.id)?.id ?? "";
    const key = rooms.map((x) => `${x.id}:${x.metadata?.name}`).join("|") + current;
    if (r.move.dataset.key !== key) {
      r.move.dataset.key = key;
      r.move.replaceChildren(h("option", { value: "" }, "Uten rom"), ...rooms.map((x) => h("option", { value: x.id }, x.metadata?.name ?? "Rom")));
      r.move.value = current;
    }
  }
}

// --- Detaljvisningen: farge for alle, scener, legge til lamper, innstillinger ---

function renderDetailExtras(group, v) {
  const lights = roomLights(group);
  const ctLights = lights.filter((l) => l.color_temperature?.mirek_schema);
  const colorLights = lights.filter((l) => l.color);
  document.getElementById("detail-ct").closest("label").hidden = !ctLights.length;
  document.getElementById("detail-color").closest("label").hidden = !colorLights.length;
  document.getElementById("detail-color-row").hidden = !ctLights.length && !colorLights.length;
  if (!dragging.has(`detailcolor:${group.id}`)) {
    const lit = lights.find((l) => l.on?.on && l.color_temperature?.mirek_valid);
    if (lit) document.getElementById("detail-ct").value = String(lit.color_temperature.mirek);
    if (v.tint) document.getElementById("detail-color").value = rgbToHex(v.tint);
  }

  // Scener som kan redigeres.
  const list = document.getElementById("scene-list");
  const manage = document.getElementById("scene-manage");
  const scenes = all("scene").filter((s) => s.group?.rid === group.id).sort((a, b) => collator.compare(a.metadata?.name ?? "", b.metadata?.name ?? ""));
  const key = scenes.map((s) => `${s.id}:${s.metadata?.name}:${s.speed}:${hasPalette(s)}`).join("|");
  if (manage.open && list.dataset.key !== key && !list.contains(document.activeElement)) {
    list.dataset.key = key;
    list.replaceChildren(...(scenes.length ? scenes.map(sceneRow) : [h("li", { class: "empty" }, "Ingen scener ennå.")]));
  }

  // Lamper som kan legges til.
  const add = document.getElementById("add-lights");
  const isZone = group.type === "zone";
  document.getElementById("add-lights-summary").textContent = isZone ? "Legg til lamper i sonen" : "Flytt lamper hit";
  document.getElementById("add-lights-hint").textContent = isZone
    ? "En lampe kan være med i flere soner samtidig."
    : "En lampe kan bare være i ett rom, så den flyttes hit fra rommet den er i nå.";
  if (add.open) {
    const pick = document.getElementById("add-lights-list");
    const items = isZone ? zoneCandidates(group) : roomCandidates(group);
    const ikey = items.map((i) => i.id + i.note).join("|");
    if (pick.dataset.key !== ikey) {
      pick.dataset.key = ikey;
      pick.replaceChildren(...(items.length ? items.map(pickItem) : [h("p", { class: "empty" }, "Ingen flere lamper å legge til.")]));
    }
  }

  // Innstillinger fylles bare når dialogen åpnes, eller når ingen redigerer.
  const form = document.getElementById("group-settings");
  if (!form.contains(document.activeElement)) {
    document.getElementById("group-name").value = group.metadata?.name ?? "";
    document.getElementById("group-type-field").querySelector("span").textContent = isZone ? "Sonetype" : "Romtype";
    const sel = document.getElementById("group-type");
    if (sel.dataset.for !== `${group.id}:${group.metadata?.archetype}`) {
      sel.dataset.for = `${group.id}:${group.metadata?.archetype}`;
      archetypeOptions(sel, group.metadata?.archetype);
    }
    document.getElementById("group-delete").textContent = isZone ? "Slett sonen" : "Slett rommet";
  }
}

function pickItem(item) {
  return h("label", { class: "pick" }, h("input", { type: "checkbox", value: item.id }), h("span", {}, item.name), item.note ? h("span", { class: "muted" }, item.note) : null);
}

function roomCandidates(room) {
  return lightDevices()
    .filter((d) => !(room?.children ?? []).some((c) => c.rid === d.id))
    .map((d) => ({ id: d.id, name: d.metadata?.name ?? "Lampe", note: roomOfDevice(d.id)?.metadata?.name ?? "uten rom" }))
    .sort((a, b) => collator.compare(a.note, b.note) || collator.compare(a.name, b.name));
}

function zoneCandidates(zone) {
  return all("light")
    .filter((l) => !(zone?.children ?? []).some((c) => c.rid === l.id))
    .map((l) => ({ id: l.id, name: lightName(l), note: roomOfDevice(l.owner?.rid)?.metadata?.name ?? "uten rom" }))
    .sort((a, b) => collator.compare(a.note, b.note) || collator.compare(a.name, b.name));
}

const checked = (box) => [...box.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);

function sceneRow(scene) {
  const nameIn = h("input", { type: "text", class: "text-in", maxlength: 32, value: scene.metadata?.name ?? "", "aria-label": "Navn på scenen" });
  const form = h("form", { class: "inline grow" }, nameIn, h("button", { type: "submit", class: "small" }, "Gi nytt navn"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (name) resource("PUT", "scene", scene.id, { metadata: { name } }).catch(() => {});
    nameIn.blur();
  });
  const group = byId.get(scene.group?.rid);
  const actions = h("div", { class: "inline" },
    hasPalette(scene) ? h("button", { type: "button", class: "small", onclick: () => resource("PUT", "scene", scene.id, { recall: { action: "dynamic_palette" } }).catch(() => {}) }, "Spill dynamisk") : null,
    h("button", {
      type: "button", class: "small",
      onclick: () => group && confirm(`Erstatte «${scene.metadata?.name}» med lyset slik det er nå?`) && resource("PUT", "scene", scene.id, { actions: currentActions(group) }).catch(() => {}),
    }, "Bytt til lyset nå"),
    h("button", {
      type: "button", class: "small danger",
      onclick: () => confirm(`Slette scenen «${scene.metadata?.name}»? Den forsvinner også fra Hue-appen.`) && resource("DELETE", "scene", scene.id).catch(() => {}),
    }, "Slett"));
  let speed = null;
  if (hasPalette(scene)) {
    const input = h("input", { type: "range", class: "dim", min: 0, max: 100, step: 1, value: Math.round((scene.speed ?? 0.5) * 100), "aria-label": "Fart" });
    input.style.setProperty("--fill", `${input.value}%`);
    input.addEventListener("input", () => input.style.setProperty("--fill", `${input.value}%`));
    input.addEventListener("change", () => resource("PUT", "scene", scene.id, { speed: Number(input.value) / 100 }).catch(() => {}));
    speed = h("label", { class: "field" }, h("span", {}, "Fart på dynamisk modus"), input);
  }
  return h("li", { class: "manage-item" }, form, actions, speed);
}

{
  const ct = document.getElementById("detail-ct");
  const color = document.getElementById("detail-color");
  const glOf = () => openGroupId && roomView(byId.get(openGroupId)).glId;
  const sendCt = throttled(1000, ({ glId, mirek }) => api("PUT", `/api/grouped_light/${glId}`, { mirek }));
  const sendColor = throttled(1000, ({ glId, xy }) => api("PUT", `/api/grouped_light/${glId}`, { xy }));
  const hold = () => openGroupId && dragging.add(`detailcolor:${openGroupId}`);
  const release = () => openGroupId && dragging.delete(`detailcolor:${openGroupId}`);
  ct.addEventListener("pointerdown", hold);
  ct.addEventListener("change", release);
  ct.addEventListener("input", () => glOf() && sendCt({ glId: glOf(), mirek: Number(ct.value) }));
  color.addEventListener("focus", hold);
  color.addEventListener("blur", release);
  color.addEventListener("input", () => glOf() && sendColor({ glId: glOf(), xy: hexToXy(color.value) }));

  document.getElementById("scene-manage").addEventListener("toggle", () => {
    document.getElementById("scene-list").dataset.key = "";
    scheduleRender();
  });
  document.getElementById("add-lights").addEventListener("toggle", () => {
    document.getElementById("add-lights-list").dataset.key = "";
    scheduleRender();
  });

  document.getElementById("scene-save").addEventListener("click", async () => {
    const group = byId.get(openGroupId);
    if (!group) return;
    const name = prompt("Navn på den nye scenen:", "")?.trim();
    if (!name) return;
    await resource("POST", "scene", null, {
      metadata: { name: name.slice(0, 32) },
      group: { rid: group.id, rtype: group.type },
      actions: currentActions(group),
    }).catch(() => {});
  });

  document.getElementById("add-lights-go").addEventListener("click", async () => {
    const group = byId.get(openGroupId);
    const ids = checked(document.getElementById("add-lights-list"));
    if (!group || !ids.length) return;
    try {
      if (group.type === "zone") {
        const children = [...(group.children ?? []), ...ids.map((rid) => ({ rid, rtype: "light" }))];
        await resource("PUT", "zone", group.id, { children });
      } else {
        await assignDevicesToRoom(ids, group.id);
      }
      document.getElementById("add-lights").open = false;
    } catch {}
  });

  document.getElementById("group-settings").addEventListener("submit", (e) => {
    e.preventDefault();
    const group = byId.get(openGroupId);
    const name = document.getElementById("group-name").value.trim();
    if (!group || !name) return;
    resource("PUT", group.type, group.id, { metadata: { name, archetype: document.getElementById("group-type").value } }).catch(() => {});
    document.activeElement?.blur();
  });

  document.getElementById("group-delete").addEventListener("click", async () => {
    const group = byId.get(openGroupId);
    if (!group) return;
    const what = group.type === "zone" ? "sonen" : "rommet";
    const extra = group.type === "zone" ? "Lampene blir ikke slettet." : "Lampene blir liggende uten rom, og scenene for rommet slettes.";
    if (!confirm(`Slette ${what} «${group.metadata?.name}»? ${extra} Det forsvinner også fra Hue-appen.`)) return;
    try {
      await resource("DELETE", group.type, group.id);
      document.getElementById("detail").close();
    } catch {}
  });
}

// --- Nytt rom eller ny sone ---

{
  const dlg = document.getElementById("create");
  const form = document.getElementById("create-form");
  let kind = "room";

  const open = (k) => {
    kind = k;
    const isZone = kind === "zone";
    document.getElementById("create-title").textContent = isZone ? "Ny sone" : "Nytt rom";
    document.getElementById("create-go").textContent = isZone ? "Lag sonen" : "Lag rommet";
    document.getElementById("create-hint").textContent = isZone
      ? "Velg lampene som skal være med. De blir også værende i rommene sine."
      : "Velg lampene som skal være i rommet. De flyttes fra rommet de er i nå.";
    document.getElementById("create-name").value = "";
    archetypeOptions(document.getElementById("create-type"), isZone ? "home" : "living_room");
    const items = isZone ? zoneCandidates(null) : roomCandidates(null);
    document.getElementById("create-lights").replaceChildren(...items.map(pickItem));
    dlg.showModal();
    document.getElementById("create-name").focus();
  };
  for (const b of document.querySelectorAll("[data-create]")) b.addEventListener("click", () => open(b.dataset.create));
  document.getElementById("create-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("create-name").value.trim();
    if (!name) return;
    const ids = checked(document.getElementById("create-lights"));
    const metadata = { name, archetype: document.getElementById("create-type").value };
    const go = document.getElementById("create-go");
    go.disabled = true;
    try {
      if (kind === "room") {
        await assignDevicesToRoom(ids, null); // ut av gamle rom først
        await resource("POST", "room", null, { metadata, children: ids.map((rid) => ({ rid, rtype: "device" })) });
      } else {
        await resource("POST", "zone", null, { metadata, children: ids.map((rid) => ({ rid, rtype: "light" })) });
      }
      dlg.close();
    } catch {
    } finally {
      go.disabled = false;
    }
  });
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

// ---------- Sonos ----------

let spotifyOn = false;
let sonos = null; // { available, reason, groups: [...] } fra serveren, eller null når Sonos er slått av
const sonosEls = new Map(); // gruppe-id -> { el, refs }

const ICONS = {
  prev: "M19 20 9 12l10-8v16zM5 19V5",
  next: "m5 4 10 8-10 8V4zM19 5v14",
  speaker: "M11 5 6 9H2v6h4l5 4V5z",
};

function icon(d, size = 20) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function playIcon(playing) {
  const svg = icon(playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 4v16l13-8z", 26);
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  return svg;
}

const sonosUrl = (kind, id, action) => `/api/sonos/${kind}/${encodeURIComponent(id)}/${action}`;

function volumeSlider(label, onValue) {
  const input = h("input", { type: "range", class: "dim", min: 0, max: 100, step: 1, "aria-label": label });
  const out = h("output", { class: "vol-out" });
  const send = throttled(250, (v) => onValue(v));
  input.addEventListener("pointerdown", () => (input.dataset.drag = "1"));
  input.addEventListener("change", () => delete input.dataset.drag);
  input.addEventListener("input", () => {
    out.textContent = input.value;
    input.style.setProperty("--fill", `${input.value}%`);
    send(Number(input.value));
  });
  return { input, out };
}

function setSlider(s, value) {
  if (s.input.dataset.drag || document.activeElement === s.input) return;
  s.input.value = value;
  s.out.textContent = value;
  s.input.style.setProperty("--fill", `${value}%`);
}

function createSonosEl(id) {
  const g = () => sonos?.groups.find((x) => x.id === id);
  const art = h("div", { class: "np-art", "aria-hidden": "true" });
  const title = h("strong", { class: "np-title" });
  const artist = h("span", { class: "np-artist" });
  const name = h("h3", {});
  const state = h("span", { class: "meta" });
  const btn = (label, d, action) =>
    h("button", { type: "button", class: "np-btn", "aria-label": label, onclick: () => api("POST", sonosUrl("group", id, action)) }, icon(d, 22));
  const play = h("button", {
    type: "button",
    class: "np-play",
    onclick: () => {
      const grp = g();
      if (!grp) return;
      const playing = grp.state === "playing" || grp.state === "transitioning";
      grp.state = playing ? "paused" : "playing"; // vises med en gang, rettes av neste oppdatering
      renderSonos();
      api("POST", sonosUrl("group", id, playing ? "pause" : "play"));
    },
  });
  const mute = h("button", {
    type: "button",
    class: "np-btn small-btn",
    onclick: () => {
      const grp = g();
      if (grp) api("PUT", sonosUrl("group", id, "volume"), { mute: !grp.muted });
    },
  });
  const vol = volumeSlider("Volum", (v) => api("PUT", sonosUrl("group", id, "volume"), { volume: v }));
  const memberList = h("div", { class: "np-members" });
  const members = h("details", { class: "more np-more" }, h("summary", {}, "Volum per rom"), memberList);
  const memberEls = new Map();

  const el = h(
    "article",
    { class: "np" },
    h("div", { class: "room-head" }, name, state),
    h("div", { class: "np-track" }, art, h("div", { class: "np-text" }, title, artist)),
    h("div", { class: "np-controls" }, btn("Forrige", ICONS.prev, "previous"), play, btn("Neste", ICONS.next, "next")),
    h("div", { class: "np-vol" }, mute, vol.input, vol.out),
    h(
      "div",
      { class: "np-actions" },
      h("button", { type: "button", class: "small", onclick: () => g() && openFavorites(g().coordinator) }, "Velg musikk"),
      h("button", { type: "button", class: "small", onclick: () => g() && openRooms(g().coordinator) }, "Rom i gruppen"),
    ),
    members,
  );
  return { el, refs: { art, title, artist, name, state, play, mute, vol, members, memberList, memberEls } };
}

const STATE_TEXT = { playing: "Spiller", paused: "Pause", stopped: "Stoppet", transitioning: "Starter …" };

function updateSonosEl(entry, g) {
  const r = entry.refs;
  const playing = g.state === "playing" || g.state === "transitioning";
  entry.el.classList.toggle("off", !playing);
  r.name.textContent = g.name;
  r.state.textContent = STATE_TEXT[g.state] ?? "";
  const t = g.track;
  r.title.textContent = t?.title || "Ingenting valgt";
  r.artist.textContent = t ? [t.artist, t.source].filter(Boolean).join(" · ") : "Trykk «Velg musikk» under";
  if ((r.art.dataset.src ?? "") !== (t?.art ?? "")) {
    r.art.dataset.src = t?.art ?? "";
    r.art.replaceChildren();
    if (t?.art) {
      const img = h("img", { src: t.art, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      img.addEventListener("error", () => img.remove());
      r.art.append(img);
    }
  }
  r.play.replaceChildren(playIcon(playing));
  r.play.setAttribute("aria-label", playing ? "Pause" : "Spill");
  r.mute.replaceChildren(icon(g.muted ? "M11 5 6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6" : "M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7", 20));
  r.mute.setAttribute("aria-label", g.muted ? "Slå på lyden" : "Demp");
  r.mute.setAttribute("aria-pressed", String(g.muted));
  setSlider(r.vol, g.volume);

  r.members.hidden = g.members.length < 2;
  for (const [uuid, m] of r.memberEls) if (!g.members.some((x) => x.uuid === uuid)) { m.row.remove(); r.memberEls.delete(uuid); }
  for (const m of g.members) {
    let row = r.memberEls.get(m.uuid);
    if (!row) {
      const label = h("span", { class: "np-member-name" });
      const s = volumeSlider(`Volum ${m.name}`, (v) => api("PUT", sonosUrl("player", m.uuid, "volume"), { volume: v }));
      row = { row: h("div", { class: "np-member" }, label, s.input, s.out), label, s };
      r.memberEls.set(m.uuid, row);
    }
    row.label.textContent = m.muted ? `${m.name} (dempet)` : m.name;
    setSlider(row.s, m.volume);
    r.memberList.append(row.row); // holder rekkefølgen lik gruppens
  }
}

function renderSonos() {
  if (!sonos) return;
  const hint = document.getElementById("music-hint");
  hint.hidden = !sonos.reason;
  hint.textContent = sonos.reason;
  const groups = sonos.groups ?? [];
  const speakers = groups.reduce((n, g) => n + g.members.length, 0);
  document.getElementById("music-count").textContent = groups.length ? `${speakers} høyttalere` : "";
  const grid = document.getElementById("music-groups");
  for (const [id, entry] of sonosEls) if (!groups.some((g) => g.id === id)) { entry.el.remove(); sonosEls.delete(id); }
  for (const g of groups) {
    let entry = sonosEls.get(g.id);
    if (!entry) sonosEls.set(g.id, (entry = createSonosEl(g.id)));
    updateSonosEl(entry, g);
    grid.append(entry.el);
  }
}

// ---------- Musikk: favoritter og grupper ----------

// Dialogene følger rommet som styrer gruppen, siden gruppens id endres når rom kommer og går.
let favFor = null;
let roomsFor = null;
const groupOf = (coordinator) => sonos?.groups.find((g) => g.coordinator === coordinator);

function openFavorites(coordinator) {
  favFor = coordinator;
  renderFavorites();
  const box = document.getElementById("spotify-box");
  box.hidden = !spotifyOn;
  document.getElementById("sonos-fav-head").hidden = !spotifyOn;
  document.getElementById("sonos-fav").showModal();
  if (spotifyOn) document.getElementById("spotify-q").focus();
}

/** Lager en knapp med bilde for en favoritt eller et søketreff. */
function musicTile(title, sub, artUrl, play) {
  const art = h("div", { class: "fav-art", "aria-hidden": "true" });
  if (artUrl) {
    const img = h("img", { src: artUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    art.append(img);
  }
  const btn = h(
    "button",
    {
      type: "button",
      class: "fav",
      onclick: async () => {
        const grp = groupOf(favFor);
        if (!grp) return;
        btn.disabled = true;
        const ok = await play(grp);
        btn.disabled = false;
        if (ok) document.getElementById("sonos-fav").close();
      },
    },
    art,
    h("strong", {}, title),
    h("span", {}, sub),
  );
  return btn;
}

let searchSeq = 0;
async function runSpotifySearch(q) {
  const seq = ++searchSeq;
  const hint = document.getElementById("spotify-hint");
  const list = document.getElementById("spotify-results");
  if (!q.trim()) {
    hint.hidden = true;
    list.replaceChildren();
    return;
  }
  hint.hidden = false;
  hint.textContent = "Søker …";
  try {
    const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}`);
    const data = await res.json().catch(() => ({}));
    if (seq !== searchSeq) return; // et nyere søk er på vei
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const hits = data.results ?? [];
    hint.textContent = hits.length ? "" : "Fant ingenting. Prøv et annet ord.";
    hint.hidden = Boolean(hits.length);
    list.replaceChildren(
      ...hits.map((r) =>
        musicTile(r.title, r.subtitle, r.art, (grp) =>
          api("POST", sonosUrl("group", grp.id, "spotify"), { type: r.type, id: r.id, title: r.title }),
        ),
      ),
    );
  } catch (err) {
    if (seq !== searchSeq) return;
    hint.textContent = `Søket feilet: ${err.message}`;
  }
}

{
  const input = document.getElementById("spotify-q");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSpotifySearch(input.value), 350);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    clearTimeout(timer);
    runSpotifySearch(input.value);
  });
}

function renderFavorites() {
  const dlg = document.getElementById("sonos-fav");
  const g = favFor && groupOf(favFor);
  if (!g) return;
  document.getElementById("sonos-fav-title").textContent = `Spill i ${g.name}`;
  const favs = sonos?.favorites ?? [];
  const hint = document.getElementById("sonos-fav-hint");
  hint.textContent = favs.length
    ? "Trykk på det du vil høre."
    : "Ingen favoritter ennå. Trykk på hjertet ved en spilleliste, et album eller en radiokanal i Sonos-appen, så dukker den opp her.";
  const list = document.getElementById("sonos-fav-list");
  if (list.dataset.key === JSON.stringify(favs)) return;
  list.dataset.key = JSON.stringify(favs);
  list.replaceChildren(
    ...favs.map((f) => musicTile(f.title, f.kind, f.art, (grp) => api("POST", sonosUrl("group", grp.id, "favorite"), { favoriteId: f.id }))),
  );
}

function openRooms(coordinator) {
  roomsFor = coordinator;
  delete document.getElementById("sonos-rooms-list").dataset.key;
  renderSpeakerPicker();
  document.getElementById("sonos-rooms").showModal();
}

function renderSpeakerPicker() {
  const g = roomsFor && groupOf(roomsFor);
  if (!g) return;
  const lead = g.members.find((m) => m.uuid === g.coordinator) ?? g.members[0];
  document.getElementById("sonos-rooms-title").textContent = `Rom som spiller sammen med ${lead.name}`;
  const split = document.getElementById("sonos-split");
  split.textContent = `Bare ${lead.name}`;
  split.disabled = g.members.length < 2;
  const players = sonos.groups.flatMap((x) => x.members.map((m) => ({ ...m, group: x }))).sort((a, b) => collator.compare(a.name, b.name));
  document.getElementById("sonos-all").disabled = players.length === g.members.length;
  const list = document.getElementById("sonos-rooms-list");
  // Tegn bare på nytt når noe synlig har endret seg, så et trykk ikke havner på en knapp som byttes ut.
  const key = JSON.stringify([g.coordinator, players.map((p) => [p.uuid, p.name, p.group.coordinator, p.group.state, p.group.track?.title])]);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(
    ...players.map((p) => {
      const inGroup = p.group.coordinator === g.coordinator;
      const isLead = p.uuid === g.coordinator;
      const other = p.group.state === "playing" ? `Spiller ${p.group.track?.title ?? "noe annet"}` : "Stille";
      const sub = isLead ? "Styrer gruppen" : inGroup ? "Med. Trykk for å ta ut" : `${other}. Trykk for å legge til`;
      return h(
        "button",
        {
          type: "button",
          class: "room-pick",
          "aria-pressed": String(inGroup),
          disabled: isLead,
          onclick: () => {
            const cur = groupOf(roomsFor);
            if (!cur) return;
            if (inGroup) api("POST", sonosUrl("player", p.uuid, "leave"));
            else api("POST", sonosUrl("player", p.uuid, "join"), { groupId: cur.id });
          },
        },
        h("strong", {}, p.name),
        h("span", {}, sub),
      );
    }),
  );
}

{
  for (const id of ["sonos-fav", "sonos-rooms"]) {
    const dlg = document.getElementById(id);
    dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
    dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  }
  document.getElementById("sonos-fav").addEventListener("close", () => (favFor = null));
  document.getElementById("sonos-rooms").addEventListener("close", () => (roomsFor = null));
  document.getElementById("sonos-all").addEventListener("click", () => {
    const g = groupOf(roomsFor);
    if (g) api("POST", sonosUrl("group", g.id, "all"));
  });
  document.getElementById("sonos-split").addEventListener("click", () => {
    const g = groupOf(roomsFor);
    if (g) api("POST", sonosUrl("group", g.id, "split"));
  });
}

function renderSonosDialogs() {
  if (favFor) renderFavorites();
  if (roomsFor) {
    // Rommet som styrte gruppen, kan ha blitt tatt ut av en annen. Lukk da dialogen.
    if (!groupOf(roomsFor)) document.getElementById("sonos-rooms").close();
    else renderSpeakerPicker();
  }
}

// ---------- Faner ----------

const TABS = ["lys", "musikk", "sikkerhet"];
let tab = TABS.includes(storage("tab")) ? storage("tab") : "lys";

function showTab(name, focus = false) {
  if (!TABS.includes(name) || document.getElementById(`tab-${name}`).hidden) name = "lys";
  tab = name;
  for (const t of TABS) {
    const btn = document.getElementById(`tab-${t}`);
    const on = t === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    document.getElementById(`panel-${t}`).hidden = !on;
    if (on && focus) btn.focus();
  }
}

function setStatus(id, text, kind = "") {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `tab-status${kind ? ` ${kind}` : ""}`;
}

const shortTime = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" });

function renderTabs() {
  const roomsOn = all("room").filter((r) => serviceOf(r, "grouped_light")?.on?.on).length;
  setStatus("status-lys", roomsOn ? `${roomsOn} rom har lyset på` : "Alt lys er av", roomsOn ? "active" : "");

  const musicTab = document.getElementById("tab-musikk");
  const hadMusic = !musicTab.hidden;
  musicTab.hidden = !sonos;
  if (sonos) {
    const playing = (sonos.groups ?? []).filter((g) => g.state === "playing" || g.state === "transitioning");
    if (playing.length) {
      const more = playing.length > 1 ? ` og ${playing.length - 1} til` : "";
      setStatus("status-musikk", `Spiller i ${playing[0].name}${more}`, "active");
    } else if (!(sonos.groups ?? []).length) setStatus("status-musikk", "Ikke tilkoblet");
    else setStatus("status-musikk", "Ingenting spilles");
  }
  // Fanen for musikk kommer først når serveren har fortalt om Sonos. Vis den lagrede fanen da.
  if (!hadMusic && sonos && storage("tab") === "musikk" && tab !== "musikk") showTab("musikk");
  if (hadMusic && !sonos && tab === "musikk") showTab("lys");

  const ring = latestRing();
  const today = new Date().toDateString();
  const issues =
    all("device_power").filter((p) => p.power_state && (p.power_state.battery_state !== "normal" || p.power_state.battery_level <= 15)).length +
    all("zigbee_connectivity").filter((z) => z.status && z.status !== "connected").length;
  if (ring && new Date(ring.time).toDateString() === today) {
    const recent = Date.now() - new Date(ring.time).getTime() < BELL_WINDOW_MS;
    setStatus("status-sikkerhet", `Det ringte på kl. ${shortTime.format(new Date(ring.time))}`, recent ? "alert" : "");
  } else if (issues) setStatus("status-sikkerhet", `${issues} ting å sjekke`);
  else setStatus("status-sikkerhet", "Ingen har ringt på i dag");
}

{
  const tabs = TABS.map((t) => document.getElementById(`tab-${t}`));
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      storage("tab", btn.dataset.tab);
      showTab(btn.dataset.tab);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const visible = tabs.filter((b) => !b.hidden);
      const i = visible.indexOf(btn) + (e.key === "ArrowRight" ? 1 : -1);
      const next = visible[(i + visible.length) % visible.length];
      storage("tab", next.dataset.tab);
      showTab(next.dataset.tab, true);
      e.preventDefault();
    });
  }
  showTab(tab);
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
    renderDetail();
    renderSonos();
    renderSonosDialogs();
    renderTabs();
  });
}

// ---------- Kontakt med serveren ----------

/** Sender en kommando. Feil vises i hendelseslisten. Med strict kastes feilen videre i tillegg. */
async function api(method, url, body, strict = false) {
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
    eventItems.unshift({ time: new Date().toISOString(), text: `Kommandoen feilet: ${err.message}`, kind: "warn", isNew: true });
    scheduleRender();
    if (strict) throw err;
    return null;
  }
}

/** Kommando mot en ressurs på broen via serverens kontrollerte proxy. */
const resource = (method, type, id, body) => api(method, `/api/resource/${type}${id ? `/${id}` : ""}`, body, true);

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
    sonos = snap.sonos ?? null;
    spotifyOn = Boolean(snap.spotify);
    eventItems.length = 0;
    addEvents(snap.recent ?? [], false);
    scheduleRender();
  });
  es.addEventListener("sonos", (e) => {
    sonos = JSON.parse(e.data);
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
