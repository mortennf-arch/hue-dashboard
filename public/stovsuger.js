// Felles for dashbordet og kjøkkenvisningen: fanen «Støvsuger» med Roborock-støvsugerne.
// Siden får tilstanden fra serveren (hendelsen «roborock») og kaller Stovsuger.update(state).

(() => {
  const FAN = [
    [101, "Stille"],
    [102, "Balansert"],
    [103, "Turbo"],
    [104, "Maks"],
  ];
  const WATER = [
    [200, "Av"],
    [201, "Lite"],
    [202, "Middels"],
    [203, "Mye"],
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const svg = (d, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    play: svg('<path d="M7 4v16l13-8z"/>'),
    pause: svg('<path d="M8 5v14M16 5v14"/>'),
    home: svg('<path d="M3 11l9-7 9 7M5 10v10h14V10"/>'),
    find: svg('<path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    robot: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3"/>', 28),
  };

  let root = null;
  let big = false;
  let state = null;
  let busy = "";
  let message = { text: "", bad: false };
  let deferred = false;
  /** Rommene som er krysset av, per støvsuger. Huskes mellom tegningene. */
  const picked = new Map();
  const repeat = new Map();

  function mount(el, opts = {}) {
    root = el;
    big = Boolean(opts.big);
    root.classList.add("rb", big ? "rb-big" : "rb-small");
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

  function onClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const { act, duid } = b.dataset;
    const cmd = (body, done) => run(`${duid}:${body.action}${body.value ?? ""}`, `/api/roborock/${encodeURIComponent(duid)}/command`, body, done);
    if (act === "room") {
      const set = picked.get(duid) ?? new Set();
      const seg = Number(b.dataset.seg);
      set.has(seg) ? set.delete(seg) : set.add(seg);
      picked.set(duid, set);
      render(true);
    } else if (act === "repeat") {
      repeat.set(duid, repeat.get(duid) === 2 ? 1 : 2);
      render(true);
    } else if (act === "rooms") {
      const segs = [...(picked.get(duid) ?? [])];
      cmd({ action: "rooms", segments: segs, repeat: repeat.get(duid) ?? 1 }, "");
      picked.delete(duid);
    } else if (act === "find") cmd({ action: "find" }, "Den piper nå, så du hører hvor den er.");
    else if (act === "fan" || act === "water") cmd({ action: act, value: Number(b.dataset.value) });
    else if (["start", "pause", "dock", "stop"].includes(act)) cmd({ action: act });
    else if (act === "refresh") run("refresh", "/api/roborock/refresh", {}, "Henter støvsugere og rom fra Roborock-kontoen …");
    else if (act === "logout") {
      if (confirm("Logge ut av Roborock? Dashbordet glemmer støvsugerne til du logger inn igjen.")) run("logout", "/api/roborock/logout");
    } else if (act === "rescan") run(`${duid}:ip`, `/api/roborock/${encodeURIComponent(duid)}/ip`, { ip: "" }, "Leter etter støvsugeren på nettet …");
    else if (act === "resend") run("code", "/api/roborock/code", { email: state?.email ?? "" });
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

  const btn = (act, label, opts = {}) => {
    const key = `${opts.duid ?? ""}:${act === "fan" || act === "water" ? `${act}${opts.value}` : act}`;
    const attrs = [`type="button"`, `data-act="${act}"`, opts.duid ? `data-duid="${esc(opts.duid)}"` : "", opts.value !== undefined ? `data-value="${opts.value}"` : "", opts.seg !== undefined ? `data-seg="${opts.seg}"` : "", `class="${opts.cls ?? "rb-btn"}"`, opts.pressed !== undefined ? `aria-pressed="${opts.pressed}"` : "", opts.disabled || (busy && busy === key) ? "disabled" : ""];
    return `<button ${attrs.filter(Boolean).join(" ")}>${opts.icon ?? ""}<span>${esc(label)}</span></button>`;
  };

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

  function batteryText(v) {
    if (v.battery === null) return "";
    return `${v.battery} %`;
  }

  function vacuumCard(v) {
    const d = v.duid;
    const paused = v.state === 10;
    const set = picked.get(d) ?? new Set();
    // Rom som ikke finnes lenger, tas ut av valget.
    for (const s of set) if (!v.rooms.some((r) => r.segment === s)) set.delete(s);
    const off = !v.connected;
    const head = `<header class="rb-head">
        <span class="rb-icon ${v.active ? "rb-on" : ""}">${ICON.robot}</span>
        <div class="rb-title"><h2>${esc(v.name)}</h2>${v.model && v.model !== v.name ? `<span class="rb-muted">${esc(v.model)}</span>` : ""}</div>
        <div class="rb-state">
          <strong class="${v.error ? "rb-bad" : v.active ? "rb-accent" : ""}">${esc(off ? "Ikke tilkoblet" : v.stateText || "…")}</strong>
          ${v.battery !== null ? `<span class="rb-battery" title="Batteri"><span class="rb-battery-bar" style="width:${Math.max(4, v.battery)}%"></span></span><span class="rb-muted">${batteryText(v)}</span>` : ""}
        </div>
      </header>`;
    if (off) {
      return `<article class="rb-card">${head}
        <p class="rb-muted">${esc(v.problem)}</p>
        <form data-form="ip" data-duid="${esc(d)}" class="rb-form">
          <label class="rb-sr" for="rb-ip-${esc(d)}">IP-adresse</label>
          <input id="rb-ip-${esc(d)}" class="rb-input" inputmode="decimal" placeholder="IP-adresse, for eksempel 192.168.68.50" value="${esc(v.ip ?? "")}">
          <button type="submit" class="rb-btn" ${busy ? "disabled" : ""}><span>Bruk adressen</span></button>
        </form>
        <p class="rb-muted">Adressen står i Roborock-appen under støvsugeren: ⋯ &gt; Produktinfo, eller i ruteren. ${btn("rescan", "Let på nytt", { duid: d, cls: "rb-link" })}</p>
      </article>`;
    }
    const actions = [
      v.active && !paused ? btn("pause", "Pause", { duid: d, icon: ICON.pause, cls: "rb-btn rb-primary" }) : btn("start", paused ? "Fortsett" : "Start hele huset", { duid: d, icon: ICON.play, cls: "rb-btn rb-primary" }),
      paused ? btn("stop", "Avslutt", { duid: d, icon: ICON.stop }) : "",
      btn("dock", "Hjem til laderen", { duid: d, icon: ICON.home, disabled: v.docked }),
      btn("find", "Finn", { duid: d, icon: ICON.find }),
    ].join("");
    const rooms = v.rooms.length
      ? `<section class="rb-sec"><h3>Rom</h3>
          <div class="rb-chips">${v.rooms.map((r) => btn("room", r.name, { duid: d, seg: r.segment, cls: "rb-chip", pressed: set.has(r.segment) })).join("")}</div>
          <div class="rb-row">
            ${btn("rooms", set.size ? `Vask ${set.size === 1 ? "rommet" : `${set.size} rom`}` : "Velg rom først", { duid: d, icon: ICON.play, cls: "rb-btn rb-primary", disabled: !set.size })}
            ${btn("repeat", (repeat.get(d) ?? 1) === 2 ? "To ganger" : "Én gang", { duid: d, cls: "rb-btn rb-ghost", pressed: (repeat.get(d) ?? 1) === 2 })}
          </div>
          ${v.rooms.some((r) => /^Rom \d+$/.test(r.name)) ? `<p class="rb-muted">Gi rommene navn i Roborock-appen, og trykk «Hent på nytt» nederst.</p>` : ""}
        </section>`
      : `<section class="rb-sec"><h3>Rom</h3><p class="rb-muted">Fant ingen rom. Lag et kart og del det opp i rom i Roborock-appen.</p></section>`;
    const seg = (act, list, cur) => `<div class="rb-seg" role="group">${list.map(([value, label]) => btn(act, label, { duid: d, value, cls: "rb-segbtn", pressed: cur === value })).join("")}</div>`;
    const settings = `<section class="rb-sec rb-settings">
        <div><h3>Sugestyrke</h3>${seg("fan", FAN, v.fan)}</div>
        ${v.water !== null ? `<div><h3>Vann til moppen</h3>${seg("water", WATER, v.water)}</div>` : ""}
      </section>`;
    const facts = [];
    if (v.cleanMinutes !== null && v.cleanArea !== null) facts.push(`Siste runde: ${v.cleanMinutes} min, ${String(v.cleanArea).replace(".", ",")} m²`);
    if (v.totals) facts.push(`Totalt ${v.totals.count} runder, ${v.totals.hours} timer, ${v.totals.area.toLocaleString("nb-NO")} m²`);
    const parts = v.consumables.length
      ? `<ul class="rb-parts">${v.consumables
          .map((c) => `<li><span>${esc(c.name)}</span><span class="rb-meter"><span style="width:${c.percent}%" class="${c.percent <= 10 ? "rb-low" : ""}"></span></span><span class="rb-muted">${c.percent} %</span></li>`)
          .join("")}</ul>`
      : "";
    const low = v.consumables.filter((c) => c.percent <= 10).map((c) => c.name.toLowerCase());
    return `<article class="rb-card">${head}
      ${v.error ? `<p class="rb-alert">${esc(v.error)}</p>` : ""}
      <div class="rb-actions">${actions}</div>
      ${rooms}
      ${settings}
      <details class="rb-sec rb-more">
        <summary>Slitedeler og statistikk${low.length ? ` <span class="rb-bad">· sjekk ${esc(low.join(", "))}</span>` : ""}</summary>
        ${facts.length ? `<p class="rb-muted">${facts.map(esc).join("<br>")}</p>` : ""}
        ${parts}
        <p class="rb-muted">Prosenten er tiden som er igjen før delen bør byttes eller rengjøres. Nullstill den i Roborock-appen etter bytte.</p>
      </details>
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
      html += `<div class="rb-grid">${state.vacuums.map(vacuumCard).join("")}</div>`;
      html += `<footer class="rb-foot">${btn("refresh", "Hent støvsugere og rom på nytt", { cls: "rb-link" })} · ${btn("logout", "Logg ut av Roborock", { cls: "rb-link" })}</footer>`;
    }
    if (message.text && message.text !== state?.reason) html = `<p class="${message.bad ? "rb-bad" : "rb-muted"} rb-msg" role="status">${esc(message.text)}</p>` + html;
    root.innerHTML = html;
    // Husk hvilke «Slitedeler»-bokser som var åpne.
    root.querySelectorAll("details.rb-more").forEach((x, i) => {
      const duid = state?.vacuums?.[i]?.duid;
      if (!duid) return;
      x.dataset.duid = duid;
      if (open.has(duid)) x.open = true;
    });
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
    if (active.length) return { text: active.map((v) => `${v.name} ${v.stateText.toLowerCase()}`).join(" · "), kind: "active" };
    if (list.length && list.every((v) => !v.connected)) return { text: "Ikke tilkoblet", kind: "" };
    if (list.length && list.every((v) => v.docked)) return { text: list.length > 1 ? "Alle står i laderen" : "Står i laderen", kind: "" };
    return { text: list.map((v) => `${v.name}: ${(v.stateText || "…").toLowerCase()}`).join(" · "), kind: "" };
  }

  window.Stovsuger = { mount, update, tabStatus };
})();
