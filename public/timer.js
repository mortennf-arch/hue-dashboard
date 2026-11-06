// Felles for dashbordet og kjøkkenvisningen: timere som går på serveren.
// Når en timer er ferdig, ringer skjermene, og serveren blinker med lyset i rommet som ble valgt.

(() => {
  const PRESETS = [1, 3, 5, 10, 15, 20, 30, 45, 60];

  const left = (t) => Math.max(0, Date.parse(t.endsAt) - Date.now());

  /** Gjenstående tid som klokke: 4:05, 1:02:03. */
  function clock(ms) {
    const s = Math.ceil(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  }

  /** Varighet i ord: 45 sek, 10 min, 1 t 30 min. */
  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} sek`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return m % 60 ? `${Math.floor(m / 60)} t ${m % 60} min` : `${m / 60} t`;
  }

  const name = (t) => t.label || `Timer på ${duration(t.durationMs)}`;

  /** Rom og soner som har lys som kan blinke, sortert etter navn. */
  function rooms(byId) {
    const groups = new Set([...byId.values()].filter((r) => r.type === "grouped_light").map((r) => r.owner?.rid));
    const collator = new Intl.Collator("nb");
    return [...byId.values()]
      .filter((r) => (r.type === "room" || r.type === "zone") && groups.has(r.id))
      .sort((a, b) => collator.compare(a.metadata?.name ?? "", b.metadata?.name ?? ""));
  }

  /** Rommet som er valgt for blinking. «auto» betyr kjøkkenet hvis det finnes. */
  function pickRoom(list, saved) {
    if (saved === "") return "";
    if (saved && saved !== "auto" && list.some((r) => r.id === saved)) return saved;
    return list.find((r) => /kjøkken|kitchen/i.test(r.metadata?.name ?? ""))?.id ?? "";
  }

  /** Tre korte pip, tydelig forskjellig fra dørklokka. */
  function beep(audio) {
    if (!audio || audio.state !== "running") return;
    const now = audio.currentTime;
    for (const at of [0, 0.3, 0.6]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "square";
      osc.frequency.value = 1320;
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.12, now + at + 0.01);
      gain.gain.setValueAtTime(0.12, now + at + 0.16);
      gain.gain.linearRampToValueAtTime(0, now + at + 0.19);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.2);
    }
  }

  const ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4M12 2v3"/></svg>';

  window.Timer = { PRESETS, left, clock, duration, name, rooms, pickRoom, beep, ICON };
})();
