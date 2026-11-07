// Felles for dashbordet og kjøkkenvisningen: fanen «Bilder» og lysbildevisningen.
// Bildene ligger i en mappe på TrueNAS og hentes fra serveren (/api/photos).
// Lysbildevisningen dekker hele skjermen og kan starte av seg selv når ingen har trykket på en stund.
// Dørklokka og timeren ligger over den (z-index), og siden kaller Bilder.stop() når noe ringer.

(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const svg = (d, size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    prev: svg('<path d="m15 18-6-6 6-6"/>'),
    next: svg('<path d="m9 18 6-6-6-6"/>'),
    play: svg('<path d="M7 4v16l13-8z"/>', 24),
  };
  const IDLE = [
    [0, "Av"],
    [2, "2 min"],
    [5, "5 min"],
    [10, "10 min"],
  ];
  const SPEED = [
    [10, "10 s"],
    [15, "15 s"],
    [30, "30 s"],
    [60, "1 min"],
  ];
  const ON_THIS_DAY = "__dag";

  const dateFmt = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long", year: "numeric" });
  const clockFmt = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" });
  const weekdayFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "long" });

  let root = null;
  let opts = {};
  let summary = null;
  let list = [];
  let order = [];
  let pos = 0;
  let loadedFor = null;
  let problem = "";
  let settings = {};
  let show = null;
  let showTimer = null;
  let clockTimer = null;
  let idleTimer = null;
  let blocked = false;
  let lastTouch = Date.now();

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // privat modus, ignorer
    }
  }

  /**
   * opts.big: store knapper (nettbrettet).
   * opts.idleDefault: minutter før lysbildevisningen starter av seg selv, hvis ikke valgt på enheten.
   * opts.weather(): været nå ({temp, symbol, text}), vises nede til høyre i lysbildevisningen.
   * opts.key: prefiks for innstillingene i nettleseren.
   * opts.onSummary(summary): kalles når siden vet hvor mange bilder det er.
   */
  function mount(el, o = {}) {
    root = el;
    opts = o;
    const saved = JSON.parse(storageGet(`${o.key ?? ""}bilder`) || "null") || {};
    settings = { folder: "", idle: o.idleDefault ?? 0, speed: 15, shuffle: true, clock: true, ...saved };
    root.classList.add("bd", o.big ? "bd-big" : "bd-small");
    root.addEventListener("click", onClick);
    for (const type of ["pointerdown", "keydown", "wheel"]) document.addEventListener(type, touched, { passive: true, capture: true });
    idleTimer = setInterval(checkIdle, 10_000);
    render();
    refresh();
  }

  function save() {
    storageSet(`${opts.key ?? ""}bilder`, JSON.stringify(settings));
  }

  async function refresh() {
    try {
      const res = await fetch("/api/photos");
      summary = await res.json();
      if (!res.ok) throw new Error(summary.error || `Feil ${res.status}`);
      problem = "";
      opts.onSummary?.(summary);
      if (settings.folder && settings.folder !== ON_THIS_DAY && !summary.folders.some((f) => f.name === settings.folder)) settings.folder = "";
      await loadList(true);
    } catch (err) {
      problem = err.message;
      render();
    }
  }

  const today = () => {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  async function loadList(force = false) {
    if (!summary?.configured) return render();
    const key = `${settings.folder}|${settings.folder === ON_THIS_DAY ? today() : ""}|${summary.scannedAt}`;
    if (!force && key === loadedFor) return;
    const q = new URLSearchParams();
    if (settings.folder === ON_THIS_DAY) q.set("day", today());
    else if (settings.folder) q.set("folder", settings.folder);
    const res = await fetch(`/api/photos/list?${q}`);
    list = res.ok ? await res.json() : [];
    loadedFor = key;
    reorder();
    render();
  }

  function reorder() {
    order = list.map((_, i) => i);
    if (settings.shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    pos = 0;
  }

  const current = () => list[order[pos]] ?? null;
  const src = (p) => `/api/photos/file/${p.id}`;
  const step = (n) => {
    if (!order.length) return;
    pos = (pos + n + order.length) % order.length;
  };
  const photoDate = (p) => (p?.date ? dateFmt.format(new Date(`${p.date}T12:00:00`)) : "");
  const caption = (p) => [p?.album ?? p?.folder, photoDate(p)].filter(Boolean).join(" · ");

  function chip(value, label, on, extra = "") {
    return `<button type="button" class="bd-chip" data-act="${extra}" data-value="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;
  }

  function render() {
    if (!root) return;
    if (problem) {
      root.innerHTML = `<p class="bd-empty">Fikk ikke kontakt med bildene: ${esc(problem)}</p>`;
      return;
    }
    if (!summary) {
      root.innerHTML = `<p class="bd-empty">Henter bilder …</p>`;
      return;
    }
    if (!summary.configured || !summary.count) {
      root.innerHTML = `<div class="bd-empty"><h2>Ingen bilder ennå</h2>
        <p>${esc(summary.problem || "Fant ingen bilder.")}</p>
        <p>Legg bildene i en mappe på TrueNAS og koble den til appen. Fremgangsmåten står i guiden under «Bilder».</p>
        ${summary.skipped ? `<p>${summary.skipped === 1 ? "1 bilde" : `${summary.skipped} bilder`} i HEIC- eller RAW-format kan ikke vises i nettleseren.</p>` : ""}
        <button type="button" class="bd-btn" data-act="rescan">Se etter bilder på nytt</button></div>`;
      return;
    }
    const p = current();
    const folders = [chip("", `Alle (${summary.count})`, settings.folder === "", "folder"), ...summary.folders.map((f) => chip(f.name, f.name, settings.folder === f.name, "folder")), chip(ON_THIS_DAY, "Denne dagen", settings.folder === ON_THIS_DAY, "folder")];
    root.innerHTML = `
      <section class="bd-left" aria-labelledby="bd-folders-h">
        <h2 class="bd-h" id="bd-folders-h">Mapper</h2>
        <div class="bd-folders" role="group" aria-labelledby="bd-folders-h">${folders.join("")}</div>
      </section>
      <section class="bd-center" aria-label="Bilde">
        <div class="bd-frame">${p ? `<img src="${src(p)}" alt="${esc(caption(p) || "Bilde")}" decoding="async">` : `<p class="bd-none">${settings.folder === ON_THIS_DAY ? "Ingen bilder er tatt på denne datoen tidligere år." : "Ingen bilder i denne mappen."}</p>`}</div>
        <div class="bd-controls">
          <button type="button" class="bd-round" data-act="prev" aria-label="Forrige bilde" ${p ? "" : "disabled"}>${ICON.prev}</button>
          <span class="bd-caption">${esc(caption(p))}${order.length ? ` <small>${pos + 1} av ${order.length}</small>` : ""}</span>
          <button type="button" class="bd-round" data-act="next" aria-label="Neste bilde" ${p ? "" : "disabled"}>${ICON.next}</button>
        </div>
        <button type="button" class="bd-btn bd-start" data-act="start" ${p ? "" : "disabled"}>${ICON.play}Start lysbildevisning</button>
      </section>
      <section class="bd-right" aria-labelledby="bd-set-h">
        <h2 class="bd-h" id="bd-set-h">Start av seg selv etter</h2>
        <div class="bd-seg" role="group" aria-labelledby="bd-set-h">${IDLE.map(([v, l]) => chip(v, l, settings.idle === v, "idle")).join("")}</div>
        <p class="bd-note">Når ingen har trykket på skjermen. Gjelder bare denne skjermen.</p>
        <h2 class="bd-h" id="bd-speed-h">Bytt bilde hvert</h2>
        <div class="bd-seg" role="group" aria-labelledby="bd-speed-h">${SPEED.map(([v, l]) => chip(v, l, settings.speed === v, "speed")).join("")}</div>
        <div class="bd-toggles">
          <button type="button" class="bd-toggle" data-act="shuffle" aria-pressed="${settings.shuffle}"><strong>Tilfeldig rekkefølge</strong><small>${settings.shuffle ? "Blander bildene" : "Eldste først"}</small></button>
          <button type="button" class="bd-toggle" data-act="clock" aria-pressed="${settings.clock}"><strong>Klokke og vær</strong><small>Nederst på bildet i lysbildevisningen</small></button>
        </div>
        ${summary.skipped ? `<p class="bd-note">${summary.skipped === 1 ? "1 bilde" : `${summary.skipped} bilder`} i HEIC- eller RAW-format vises ikke.</p>` : ""}
      </section>`;
  }

  async function onClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "folder") {
      settings.folder = b.dataset.value;
      save();
      await loadList();
    } else if (act === "idle" || act === "speed") {
      settings[act] = Number(b.dataset.value);
      save();
      render();
    } else if (act === "shuffle" || act === "clock") {
      settings[act] = !settings[act];
      save();
      if (act === "shuffle") reorder();
      render();
    } else if (act === "prev" || act === "next") {
      step(act === "prev" ? -1 : 1);
      render();
    } else if (act === "start") {
      start();
    } else if (act === "rescan") {
      b.disabled = true;
      await fetch("/api/photos/rescan", { method: "POST" }).catch(() => {});
      await refresh();
    }
  }

  // ---------- Lysbildevisningen ----------
  // Liggende bilder fyller hele skjermen. Stående bilder vises to og to, side om side med en tynn vegg mellom.
  // Dra fingeren sideveis for å bla, trykk for å lukke.

  let slides = [];
  let slideAt = 0;
  let showSeq = 0;
  const portrait = (p) => p.w > 0 && p.h > p.w;

  /** Deler rekkefølgen opp i lysbilder. Et stående bilde får følge av det neste stående bildet. */
  function buildSlides() {
    const rotated = order.slice(pos).concat(order.slice(0, pos));
    const out = [];
    let waiting = -1;
    for (const i of rotated) {
      if (!portrait(list[i])) {
        out.push([i]);
      } else if (waiting < 0) {
        waiting = out.length;
        out.push([i]);
      } else {
        out[waiting].push(i);
        waiting = -1;
      }
    }
    return out;
  }

  function start() {
    if (show || !order.length) return;
    slides = buildSlides();
    slideAt = 0;
    show = document.createElement("div");
    show.className = "bd-show";
    show.setAttribute("role", "dialog");
    show.setAttribute("aria-label", "Lysbildevisning. Dra sideveis for å bla, trykk for å lukke.");
    show.innerHTML = `<div class="bd-layer"></div><div class="bd-layer"></div>
      <div class="bd-bottom" ${settings.clock ? "" : "hidden"}><span class="bd-clock bd-ol"></span><span class="bd-today bd-ol"></span></div>`;
    let down = null;
    show.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    show.addEventListener("pointerup", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      down = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) stop();
    });
    show.addEventListener("pointercancel", () => (down = null));
    document.body.append(show);
    tick();
    showSlide();
    restartTimer();
    clockTimer = setInterval(tick, 15_000);
  }

  function restartTimer() {
    clearInterval(showTimer);
    showTimer = setInterval(() => go(1, false), settings.speed * 1000);
  }

  function go(n, manual = true) {
    if (!show || !slides.length) return;
    slideAt = (slideAt + n + slides.length) % slides.length;
    showSlide(manual);
    if (manual) restartTimer();
  }

  const load = (p) =>
    new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src(p);
    });

  async function showSlide(fast = false) {
    if (!show) return;
    const seq = ++showSeq;
    const photos = slides[slideAt].map((i) => list[i]);
    const imgs = await Promise.all(photos.map(load));
    if (!show || seq !== showSeq) return;
    const panes = photos.map((p, k) => ({ p, img: imgs[k] })).filter((x) => x.img);
    if (!panes.length) return go(1, false);
    const [a, b] = show.querySelectorAll(".bd-layer");
    const front = a.classList.contains("on") ? a : b;
    const back = front === a ? b : a;
    back.className = `bd-layer${panes.length > 1 ? " bd-pair" : portrait(panes[0].p) ? " bd-alone" : ""}`;
    back.replaceChildren(
      ...panes.map(({ p, img }) => {
        const pane = document.createElement("div");
        pane.className = "bd-pane";
        img.alt = photoDate(p) ? `Bilde tatt ${photoDate(p)}` : "Bilde";
        const date = document.createElement("span");
        date.className = "bd-date bd-ol";
        date.textContent = photoDate(p);
        pane.append(img, date);
        return pane;
      }),
    );
    back.classList.toggle("fast", fast);
    front.classList.toggle("fast", fast);
    back.classList.add("on");
    front.classList.remove("on");
    // Hent neste lysbilde i forkant, så overgangen blir jevn.
    for (const i of slides[(slideAt + 1) % slides.length]) new Image().src = src(list[i]);
  }

  function tick() {
    if (!show) return;
    const now = new Date();
    show.querySelector(".bd-clock").textContent = clockFmt.format(now);
    const weekday = weekdayFmt.format(now);
    const date = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
    const wx = opts.weather?.();
    const W = window.Weather;
    show.querySelector(".bd-today").innerHTML = `<span>${esc(weekday.charAt(0).toUpperCase() + weekday.slice(1))} ${date}</span>${
      wx && W ? `<span class="bd-wx">${esc(W.temp(wx.temp))}${W.icon(wx.symbol, 44, wx.text || "")}</span>` : ""
    }`;
  }

  function stop() {
    if (!show) return;
    clearInterval(showTimer);
    clearInterval(clockTimer);
    show.remove();
    show = null;
    // Fanen viser bildet vi stoppet på.
    const first = slides[slideAt]?.[0];
    if (first !== undefined && order.includes(first)) pos = order.indexOf(first);
    lastTouch = Date.now();
    render();
  }

  function touched() {
    lastTouch = Date.now();
  }

  function checkIdle() {
    if (show || blocked || !settings.idle || !order.length || document.hidden) return;
    if (Date.now() - lastTouch < settings.idle * 60_000) return;
    // Åpne dialoger og skjemaer som er i bruk skal ikke dekkes til.
    if (document.querySelector("dialog[open]") || document.activeElement?.matches?.("input, textarea, select")) return;
    loadList().then(start);
  }

  /** Når dørklokka eller en timer ringer: lukk lysbildevisningen og ikke start den igjen før det er over. */
  function setBlocked(on) {
    blocked = Boolean(on);
    if (blocked) stop();
  }

  window.Bilder = { mount, refresh, start, stop, setBlocked, get running() { return Boolean(show); } };
})();
