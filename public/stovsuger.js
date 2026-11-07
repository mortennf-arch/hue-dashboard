// Felles for dashbordet og kjøkkenvisningen: fanen «Støvsuger» med Roborock-støvsugerne.
// Siden får tilstanden fra serveren (hendelsen «roborock») og kaller Stovsuger.update(state).
//
// Hver støvsuger har sitt kort. Når den står stille, velger man rom (gule = valgt, som rommene i
// Musikk), hva den skal gjøre, sugestyrke, vann og antall ganger, og trykker Start. Mens den
// jobber, viser kortet stort hva den holder på med akkurat nå.

(() => {
  const MODES = [
    ["both", "Støvsug og vask"],
    ["vac", "Bare støvsug"],
    ["mop", "Bare vask"],
  ];
  const FAN = [
    [101, "Stille"],
    [102, "Normal"],
    [103, "Turbo"],
    [104, "Maks"],
  ];
  const WATER = [
    [201, "Lite"],
    [202, "Middels"],
    [203, "Mye"],
  ];
  const REPEAT = [
    [1, "Én gang"],
    [2, "To ganger"],
  ];
  const DEFAULTS = { mode: "both", fan: 102, water: 202, repeat: 1, rooms: [] };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const svg = (d, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    play: svg('<path d="M7 4v16l13-8z"/>'),
    pause: svg('<path d="M8 5v14M16 5v14"/>'),
    home: svg('<path d="M3 11l9-7 9 7M5 10v10h14V10"/>'),
    find: svg('<path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    robot: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3"/>', 28),
    check: svg('<path d="M5 12l5 5 9-10"/>', 20),
  };

  let root = null;
  let state = null;
  let busy = "";
  let message = { text: "", bad: false };
  let deferred = false;

  // ---------- Valgene, husket i nettleseren per støvsuger ----------

  function prefs(duid) {
    try {
      const p = JSON.parse(localStorage.getItem(`rb:${duid}`) ?? "null");
      if (p && typeof p === "object") return { ...DEFAULTS, ...p };
    } catch {
      // privat modus eller ugyldig: bruk standard
    }
    return { ...DEFAULTS };
  }

  function savePrefs(duid, p) {
    try {
      localStorage.setItem(`rb:${duid}`, JSON.stringify(p));
    } catch {
      // ikke så farlig
    }
  }

  function setPref(duid, patch) {
    savePrefs(duid, { ...prefs(duid), ...patch });
    render(true);
  }

  // ---------- Oppsett og tegning ----------

  function mount(el, opts = {}) {
    root = el;
    root.classList.add("rb", opts.big ? "rb-big" : "rb-small");
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("focusout", () => {
      if (deferred) setTimeout(render, 0);
    });
    render();
  }

  function update(next) {
    state = next;
    render();
  }

  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Feil ${res.status}`);
    return data;
  }

  async function run(key, url, body, done) {
    if (busy) return;
    busy = key;
    message = { text: "", bad: false };
    render(true);
    try {
      await post(url, body);
      if (done) message = { text: done, bad: false };
    } catch (err) {
      message = { text: err.message, bad: true };
    } finally {
      busy = "";
      render(true);
    }
  }

  const vacuum = (duid) => state?.vacuums?.find((v) => v.duid === duid);

  function onClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const { act, duid } = b.dataset;
    const url = `/api/roborock/${encodeURIComponent(duid ?? "")}/command`;
    const cmd = (body, done) => run(`${duid}:${body.action}`, url, body, done);
    const val = b.dataset.value;
    switch (act) {
      case "room": {
        const p = prefs(duid);
        const seg = Number(val);
        setPref(duid, { rooms: p.rooms.includes(seg) ? p.rooms.filter((r) => r !== seg) : [...p.rooms, seg] });
        return;
      }
      case "mode":
        return setPref(duid, { mode: val });
      case "fan":
      case "water":
      case "repeat":
        return setPref(duid, { [act]: Number(val) });
      case "clean": {
        const v = vacuum(duid);
        const p = prefs(duid);
        const segs = p.rooms.filter((s) => v?.rooms.some((r) => r.segment === s));
        return cmd({ action: "clean", mode: v?.canMop ? p.mode : "vac", fan: p.fan, water: p.water, repeat: v?.rooms.length ? p.repeat : 1, segments: segs });
      }
      case "find":
        return cmd({ action: "find" }, "Den piper nå, så du hører hvor den er.");
      case "start":
      case "pause":
      case "dock":
      case "stop":
        return cmd({ action: act });
      case "refresh":
        return run("refresh", "/api/roborock/refresh", {}, "Henter støvsugere og rom fra Roborock-kontoen …");
      case "logout":
        if (confirm("Logge ut av Roborock? Dashbordet glemmer støvsugerne til du logger inn igjen.")) run("logout", "/api/roborock/logout");
        return;
      case "rescan":
        return run(`${duid}:ip`, `/api/roborock/${encodeURIComponent(duid)}/ip`, { ip: "" }, "Leter etter støvsugeren på nettet …");
      case "resend":
        return run("code", "/api/roborock/code", { email: state?.email ?? "" });
    }
  }

  function onSubmit(e) {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const value = f.querySelector("input")?.value ?? "";
    if (f.dataset.form === "email") run("code", "/api/roborock/code", { email: value });
    else if (f.dataset.form === "code") run("login", "/api/roborock/login", { code: value });
    else if (f.dataset.form === "ip") run(`${f.dataset.duid}:ip`, `/api/roborock/${encodeURIComponent(f.dataset.duid)}/ip`, { ip: value }, value ? "Kobler til …" : "");
  }

  /** En knapp. Er det denne som venter på svar, er den grå til svaret kommer. */
  const btn = (act, label, opts = {}) => {
    const key = `${opts.duid ?? ""}:${act}`;
    const attrs = [
      `type="button"`,
      `data-act="${act}"`,
      opts.duid ? `data-duid="${esc(opts.duid)}"` : "",
      opts.value !== undefined ? `data-value="${esc(opts.value)}"` : "",
      `class="${opts.cls ?? "rb-btn"}"`,
      opts.pressed !== undefined ? `aria-pressed="${opts.pressed}"` : "",
      opts.disabled || busy === key ? "disabled" : "",
    ];
    return `<button ${attrs.filter(Boolean).join(" ")}>${opts.icon ?? ""}<span>${esc(label)}</span>${opts.after ?? ""}</button>`;
  };

  const segmented = (act, list, current, duid, label) =>
    `<div class="rb-field"><h3>${esc(label)}</h3><div class="rb-seg" role="group" aria-label="${esc(label)}">${list
      .map(([value, text]) => btn(act, text, { duid, value, cls: "rb-segbtn", pressed: String(current === value) }))
      .join("")}</div></div>`;

  function loginView() {
    const st = state.status;
    const note = state.reason ? `<p class="${st === "login" || /stemmer|for mange|godta|fant ingen|gått ut/i.test(state.reason) ? "rb-bad" : "rb-muted"}">${esc(state.reason)}</p>` : "";
    if (st === "code_sent") {
      return `<section class="rb-card rb-login">
        <h2>Skriv inn koden</h2>
        ${note}
        <form data-form="code" class="rb-form">
          <label class="rb-sr" for="rb-code">Kode fra e-posten</label>
          <input id="rb-code" class="rb-input" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="8" required>
          <button type="submit" class="rb-btn rb-primary" ${busy ? "disabled" : ""}><span>Logg inn</span></button>
        </form>
        <p class="rb-muted">Fikk du ingen e-post? Sjekk søppelpost, eller ${btn("resend", "send en ny kode", { cls: "rb-link" })}.</p>
      </section>`;
    }
    return `<section class="rb-card rb-login">
      <h2>Koble til Roborock</h2>
      <p class="rb-muted">Skriv e-posten du bruker i Roborock-appen. Du får en kode på e-post. Det trengs bare én gang: etterpå styres støvsugerne direkte på hjemmenettet.</p>
      ${note}
      <form data-form="email" class="rb-form">
        <label class="rb-sr" for="rb-email">E-post</label>
        <input id="rb-email" class="rb-input" type="email" autocomplete="email" placeholder="navn@epost.no" value="${esc(state.email)}" required>
        <button type="submit" class="rb-btn rb-primary" ${busy ? "disabled" : ""}><span>Send kode</span></button>
      </form>
    </section>`;
  }

  /** Batteriet som et lite batteri med fyll, lyn når det lader, og prosent ved siden av. */
  function battery(v) {
    if (v.battery === null) return "";
    const charging = v.docked && v.battery < 100;
    const low = v.battery <= 20;
    return `<span class="rb-batt" title="Batteri ${v.battery} %">
      <span class="rb-batt-body${low ? " rb-batt-low" : ""}"><span class="rb-batt-fill" style="width:${Math.max(6, v.battery)}%"></span>${charging ? `<svg class="rb-bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 5 14h6l-1 8 8-12h-6z"/></svg>` : ""}</span>
      <span class="rb-batt-pct">${v.battery} %</span>
    </span>`;
  }

  const modeText = (mode) => ({ both: "Støvsug og vask", vac: "Støvsug", mop: "Vask" })[mode] ?? "Støvsug";
  const joinNames = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} og ${names[names.length - 1]}`);

  function statusClass(v) {
    if (v.error) return "rb-bad";
    if (v.active || v.state === 10) return "rb-accent";
    if (v.docked) return "rb-good";
    return "";
  }

  function head(v) {
    const sub = v.connected ? v.stateText || "…" : "Ikke tilkoblet";
    return `<header class="rb-head">
      <span class="rb-icon ${v.active ? "rb-on" : ""}">${ICON.robot}</span>
      <div class="rb-title">
        <h2>${esc(v.name)}</h2>
        <span class="rb-status ${v.connected ? statusClass(v) : "rb-muted"}">${esc(sub)}</span>
      </div>
      ${v.connected ? battery(v) : ""}
    </header>`;
  }

  /** Kortet mens den jobber: stort hva den gjør nå, hvilken jobb og hvor langt den har kommet. */
  function workingView(v) {
    const d = v.duid;
    const paused = v.state === 10;
    const returning = v.state === 6 || v.state === 15;
    const job = v.job ? `${modeText(v.job.mode)} · ${v.job.rooms.length ? joinNames(v.job.rooms) : "hele huset"}${v.job.repeat > 1 ? " · to ganger" : ""}` : "";
    const progress = [v.cleanMinutes !== null ? `${v.cleanMinutes} min så langt` : "", v.cleanArea !== null ? `${String(v.cleanArea).replace(".", ",")} m²` : ""].filter(Boolean).join(" · ");
    return `<div class="rb-now">
        <span class="rb-now-label">Akkurat nå</span>
        <strong class="rb-now-state">${esc(v.stateText || "…")}</strong>
        ${job ? `<span class="rb-now-job">${esc(job)}</span>` : ""}
        ${progress ? `<span class="rb-muted">${esc(progress)}</span>` : ""}
      </div>
      <div class="rb-grow"></div>
      <div class="rb-actions">
        ${paused ? btn("start", "Fortsett", { duid: d, icon: ICON.play, cls: "rb-btn rb-primary rb-main" }) : btn("pause", "Pause", { duid: d, icon: ICON.pause, cls: "rb-btn rb-primary rb-main" })}
        ${paused ? btn("stop", "Avslutt", { duid: d, icon: ICON.stop }) : ""}
        ${returning ? "" : btn("dock", "Hjem til laderen", { duid: d, icon: ICON.home })}
        ${btn("find", "Finn", { duid: d, icon: ICON.find })}
      </div>`;
  }

  /** Kortet når den står stille: velg rom og hvordan, og start. */
  function setupView(v) {
    const d = v.duid;
    const p = prefs(d);
    const picked = p.rooms.filter((s) => v.rooms.some((r) => r.segment === s));
    const mode = v.canMop ? p.mode : "vac";
    const options = [
      v.canMop ? segmented("mode", MODES, mode, d, "Hva?") : "",
      mode !== "mop" ? segmented("fan", FAN, p.fan, d, "Sugestyrke") : "",
      v.canMop && mode !== "vac" ? segmented("water", WATER, p.water, d, "Vann") : "",
      v.rooms.length ? segmented("repeat", REPEAT, p.repeat, d, "Ganger") : "",
    ].join("");
    const names = v.rooms.filter((r) => picked.includes(r.segment)).map((r) => r.name);
    const where = v.rooms.length ? (names.length ? joinNames(names) : "hele huset") : "";
    const label = `${modeText(mode)}${where ? `: ${where}` : ""}${v.rooms.length && p.repeat === 2 ? ", to ganger" : ""}`;
    const rooms = v.rooms.length
      ? `<div class="rb-where">
          <h3>Hvor?</h3>
          <div class="rb-rooms">${v.rooms
            .map((r) => {
              const on = picked.includes(r.segment);
              return btn("room", r.name, { duid: d, value: r.segment, cls: "rb-room", pressed: String(on), after: on ? `<span class="rb-room-mark">${ICON.check}</span>` : "" });
            })
            .join("")}</div>
          <p class="rb-muted">${picked.length ? "Trykk igjen for å ta bort et rom." : "Ingen rom valgt: hele huset vaskes."}</p>
          ${v.rooms.some((r) => /^Rom \d+$/.test(r.name)) ? `<p class="rb-muted">Gi rommene navn i Roborock-appen, og trykk «Hent på nytt» nederst.</p>` : ""}
        </div>`
      : "";
    return `<div class="rb-setup ${v.rooms.length ? "rb-has-rooms" : ""}">
        ${rooms}
        <div class="rb-options">${options}</div>
      </div>
      <div class="rb-grow"></div>
      <div class="rb-actions">
        ${btn("clean", label, { duid: d, icon: ICON.play, cls: "rb-btn rb-primary rb-main" })}
        ${v.docked ? "" : btn("dock", "Hjem", { duid: d, icon: ICON.home })}
        ${btn("find", "Finn", { duid: d, icon: ICON.find })}
      </div>`;
  }

  function offlineView(v) {
    const d = v.duid;
    return `<p class="rb-muted">${esc(v.problem)}</p>
      <form data-form="ip" data-duid="${esc(d)}" class="rb-form">
        <label class="rb-sr" for="rb-ip-${esc(d)}">IP-adresse</label>
        <input id="rb-ip-${esc(d)}" class="rb-input" inputmode="decimal" placeholder="IP-adresse, for eksempel 192.168.68.50" value="${esc(v.ip ?? "")}">
        <button type="submit" class="rb-btn" ${busy ? "disabled" : ""}><span>Bruk adressen</span></button>
      </form>
      <p class="rb-muted">Adressen står i Roborock-appen under støvsugeren: ⋯ &gt; Produktinfo, eller i ruteren. ${btn("rescan", "Let på nytt", { duid: d, cls: "rb-link" })}</p>`;
  }

  function details(v) {
    const facts = [];
    if (v.totals) facts.push(`Totalt ${v.totals.count} runder, ${v.totals.hours} timer, ${v.totals.area.toLocaleString("nb-NO")} m²`);
    const low = v.consumables.filter((c) => c.percent <= 10).map((c) => c.name.toLowerCase());
    if (!facts.length && !v.consumables.length) return "";
    return `<details class="rb-more" data-duid="${esc(v.duid)}">
        <summary>Slitedeler og statistikk${low.length ? ` <span class="rb-bad">· sjekk ${esc(low.join(", "))}</span>` : ""}</summary>
        ${facts.length ? `<p class="rb-muted">${facts.map(esc).join("<br>")}</p>` : ""}
        ${
          v.consumables.length
            ? `<ul class="rb-parts">${v.consumables
                .map((c) => `<li><span>${esc(c.name)}</span><span class="rb-meter"><span style="width:${c.percent}%" class="${c.percent <= 10 ? "rb-low" : ""}"></span></span><span class="rb-muted">${c.percent} %</span></li>`)
                .join("")}</ul>`
            : ""
        }
        <p class="rb-muted">Prosenten er tiden som er igjen før delen bør byttes eller rengjøres. Nullstill den i Roborock-appen etter bytte.</p>
      </details>`;
  }

  function vacuumCard(v) {
    const working = v.connected && (v.active || v.state === 10);
    const body = !v.connected ? offlineView(v) : working ? workingView(v) : setupView(v);
    return `<article class="rb-card ${working ? "rb-working" : ""} ${v.rooms.length ? "rb-wide" : ""}" aria-label="${esc(v.name)}">
      ${head(v)}
      ${v.error ? `<p class="rb-alert">${esc(v.error)}</p>` : ""}
      ${body}
      ${details(v)}
    </article>`;
  }

  function render(force = false) {
    if (!root) return;
    // Ikke tegn på nytt mens noen skriver i et felt.
    if (!force && root.contains(document.activeElement) && document.activeElement.matches("input")) {
      deferred = true;
      return;
    }
    deferred = false;
    const open = new Set([...root.querySelectorAll("details[data-duid][open]")].map((x) => x.dataset.duid));
    const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : "";
    const typed = focusId ? document.activeElement.value : null;
    let html = "";
    if (!state) html = `<p class="rb-muted">Kobler til …</p>`;
    else if (state.status === "login" || state.status === "code_sent") html = loginView();
    else if (state.status === "loading") html = `<p class="rb-muted">${esc(state.reason)}</p>`;
    else {
      if (state.reason) html += `<p class="${state.status === "error" ? "rb-bad" : "rb-muted"}">${esc(state.reason)}</p>`;
      // Støvsugere med rom først, de trenger mest plass.
      const list = [...state.vacuums].sort((a, b) => Number(b.rooms.length > 0) - Number(a.rooms.length > 0));
      html += `<div class="rb-grid">${list.map(vacuumCard).join("")}</div>`;
      html += `<footer class="rb-foot">${btn("refresh", "Hent støvsugere og rom på nytt", { cls: "rb-link" })} · ${btn("logout", "Logg ut av Roborock", { cls: "rb-link" })}</footer>`;
    }
    if (message.text && message.text !== state?.reason) html = `<p class="${message.bad ? "rb-bad" : "rb-muted"} rb-msg" role="status">${esc(message.text)}</p>` + html;
    root.innerHTML = html;
    for (const x of root.querySelectorAll("details[data-duid]")) if (open.has(x.dataset.duid)) x.open = true;
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        if (typed !== null && "value" in el) el.value = typed;
        el.focus();
      }
    }
  }

  /** Teksten under fanen: hva støvsugerne gjør nå. */
  function tabStatus(s) {
    if (!s) return { text: "", kind: "" };
    if (s.status === "login" || s.status === "code_sent") return { text: "Ikke koblet til", kind: "" };
    const list = s.vacuums ?? [];
    const err = list.find((v) => v.error);
    if (err) return { text: `${err.name}: ${err.error}`, kind: "alert" };
    const active = list.filter((v) => v.connected && v.active);
    if (active.length) return { text: active.map((v) => `${v.name}: ${v.stateText.toLowerCase()}`).join(" · "), kind: "active" };
    if (list.length && list.every((v) => !v.connected)) return { text: "Ikke tilkoblet", kind: "" };
    if (list.length && list.every((v) => v.docked)) return { text: list.length > 1 ? "Alle står i laderen" : "Står i laderen", kind: "" };
    return { text: list.map((v) => `${v.name}: ${(v.stateText || "…").toLowerCase()}`).join(" · "), kind: "" };
  }

  window.Stovsuger = { mount, update, tabStatus };
})();
