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
    shownAt = -1;
    show = document.createElement("div");
    show.className = "bd-show";
    show.setAttribute("role", "dialog");
    show.setAttribute("aria-label", "Lysbildevisning. Dra sideveis for å bla, trykk for å lukke.");
    show.innerHTML = `<div class="bd-layer"></div><div class="bd-layer"></div>
      <div class="bd-bottom" ${settings.clock ? "" : "hidden"}><span class="bd-clock bd-ol"></span><span class="bd-today bd-ol"></span></div>`;
    show.addEventListener("pointerdown", onDown);
    show.addEventListener("pointermove", onMove);
    show.addEventListener("pointerup", onUp);
    show.addEventListener("pointercancel", onUp);
    document.body.append(show);
    tick();
    showSlide();
    restartTimer();
    clockTimer = setInterval(tick, 15_000);
  }

  function restartTimer() {
    clearInterval(showTimer);
    showTimer = setInterval(() => go(1), settings.speed * 1000);
  }

  function go(n) {
    if (!show || !slides.length || drag || sliding) return;
    slideAt = (slideAt + n + slides.length) % slides.length;
    showSlide();
  }

  const load = (p) =>
    new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src(p);
    });

  const layers = () => {
    const [a, b] = show.querySelectorAll(".bd-layer");
    const front = a.classList.contains("on") ? a : b;
    return { front, back: front === a ? b : a };
  };

  /** Legger bildene i et lag. Bilder som ikke er lastet ennå, dukker opp når de er klare. */
  function fillLayer(layer, photos, imgs = []) {
    layer.className = `bd-layer${photos.length > 1 ? " bd-pair" : portrait(photos[0]) ? " bd-alone" : ""}`;
    layer.replaceChildren(
      ...photos.map((p, k) => {
        const img = imgs[k] ?? Object.assign(new Image(), { decoding: "async", src: src(p) });
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
  }

  const slidePhotos = (at) => slides[at].map((i) => list[i]);

  /** Henter forrige og neste lysbilde i forkant, så de er klare når man drar eller bytter. */
  function preloadNeighbours() {
    if (slides.length < 2) return;
    for (const d of [1, -1]) for (const i of slides[(shownAt + d + slides.length) % slides.length]) new Image().src = src(list[i]);
  }

  /** Automatisk bytte: myk overtoning til lysbildet slideAt. */
  async function showSlide() {
    if (!show) return;
    const seq = ++showSeq;
    const at = slideAt;
    const photos = slidePhotos(at);
    const imgs = await Promise.all(photos.map(load));
    if (!show || seq !== showSeq || drag || sliding) return;
    const ok = photos.map((p, k) => [p, imgs[k]]).filter(([, img]) => img);
    if (!ok.length) return go(1);
    const { front, back } = layers();
    fillLayer(
      back,
      ok.map(([p]) => p),
      ok.map(([, img]) => img),
    );
    back.classList.add("on");
    front.classList.remove("on");
    shownAt = at;
    preloadNeighbours();
  }

  // Dra med fingeren: bildet følger fingeren, og neste (eller forrige) bilde glir inn fra siden.
  let drag = null;
  let sliding = false;
  let shownAt = -1;
  const WALL = 6;

  function onDown(e) {
    if (sliding || drag) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, t: performance.now(), horizontal: null, dir: 0, target: -1 };
    try {
      show.setPointerCapture(e.pointerId);
    } catch {}
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.horizontal === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      drag.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!drag.horizontal || shownAt < 0) return;
      // Stopp en overtoning som pågår, og vis det som står foran.
      ++showSeq;
      slideAt = shownAt;
      clearInterval(showTimer);
      show.classList.add("dragging");
    }
    if (!drag.horizontal || shownAt < 0) return;
    const { front, back } = layers();
    const w = show.clientWidth + WALL;
    if (slides.length < 2) {
      front.style.transform = `translateX(${dx * 0.3}px)`;
      drag.dx = dx;
      return;
    }
    const dir = dx < 0 ? 1 : -1;
    if (dir !== drag.dir) {
      drag.dir = dir;
      drag.target = (shownAt + dir + slides.length) % slides.length;
      fillLayer(back, slidePhotos(drag.target));
      back.style.opacity = "1";
    }
    drag.dx = dx;
    front.style.transform = `translateX(${dx}px)`;
    back.style.transform = `translateX(${dir * w + dx}px)`;
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.horizontal) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.horizontal === null && Math.abs(dx) < 12 && Math.abs(dy) < 12 && e.type === "pointerup") stop();
      return;
    }
    if (shownAt < 0) return;
    const { front, back } = layers();
    const w = show.clientWidth + WALL;
    const speed = Math.abs(d.dx) / Math.max(1, performance.now() - d.t);
    const commit = d.target >= 0 && e.type === "pointerup" && (Math.abs(d.dx) > w * 0.22 || (Math.abs(d.dx) > 40 && speed > 0.35));
    sliding = true;
    show.classList.remove("dragging");
    show.classList.add("sliding");
    if (commit) {
      front.style.transform = `translateX(${-d.dir * w}px)`;
      back.style.transform = "translateX(0)";
    } else {
      front.style.transform = "translateX(0)";
      if (d.target >= 0) back.style.transform = `translateX(${d.dir * w}px)`;
    }
    setTimeout(() => {
      if (!show) return;
      // Bytt lag uten overtoning, og nullstill posisjonene.
      show.classList.remove("sliding");
      show.classList.add("dragging");
      if (commit) {
        back.classList.add("on");
        front.classList.remove("on");
        shownAt = slideAt = d.target;
      }
      for (const l of [front, back]) l.style.transform = l.style.opacity = "";
      void show.offsetWidth;
      show.classList.remove("dragging");
      sliding = false;
      preloadNeighbours();
      restartTimer();
    }, 330);
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
    drag = null;
    sliding = false;
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
