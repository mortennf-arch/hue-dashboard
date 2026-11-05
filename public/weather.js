// Felles for dashbordet og kjøkkenvisningen: værsymboler og små formateringer for været fra yr.
// Symbolene er tegnet her, ut fra symbolkodene til MET (for eksempel «lightrainshowers_day»).

(() => {
  const SUN = '<g class="wx-sun"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g>';
  const MOON = '<g class="wx-moon"><path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.2 6.2 0 0 0 9.7 9.7z"/></g>';
  // Liten sol eller måne oppe til venstre, bak skyen.
  const SMALL_SUN = '<g class="wx-sun"><circle cx="8.5" cy="8" r="3"/><path d="M8.5 2.3v1.4M2.8 8h1.4M4.5 4l1 1M12.5 4l-1 1M4.5 12l1-1"/></g>';
  const SMALL_MOON = '<g class="wx-moon"><path d="M12 9.6A4.6 4.6 0 1 1 6.9 3.4 3.7 3.7 0 0 0 12 9.6z"/></g>';
  const CLOUD_LOW = '<path class="wx-cloud" d="M8 20h9.5a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.7 1.3A3.2 3.2 0 0 0 8 20z"/>';
  const CLOUD_FULL = '<path class="wx-cloud" d="M6.5 19h11a4.3 4.3 0 0 0 .5-8.6A6.3 6.3 0 0 0 6 11.7 3.7 3.7 0 0 0 6.5 19z"/>';
  const CLOUD_HIGH = '<path class="wx-cloud" d="M6.5 15h11a4 4 0 0 0 .5-8A6 6 0 0 0 6.2 8.1 3.5 3.5 0 0 0 6.5 15z"/>';
  const CLOUD_HIGH_PART = '<path class="wx-cloud" d="M8.5 15h9a3.6 3.6 0 0 0 .4-7.2 5.3 5.3 0 0 0-10.1 1.2A3 3 0 0 0 8.5 15z"/>';
  const DROPS = {
    1: '<path class="wx-rain" d="M12 17.5l-1 3"/>',
    2: '<path class="wx-rain" d="M9.5 17.5l-1 3M14.5 17.5l-1 3"/>',
    3: '<path class="wx-rain" d="M8 17.5l-1 3M12 17.5l-1 3M16 17.5l-1 3"/>',
  };
  const FLAKES = {
    1: '<g class="wx-snow"><circle cx="12" cy="19.5" r="1"/></g>',
    2: '<g class="wx-snow"><circle cx="9.5" cy="19" r="1"/><circle cx="14.5" cy="20" r="1"/></g>',
    3: '<g class="wx-snow"><circle cx="8" cy="19" r="1"/><circle cx="12" cy="20.5" r="1"/><circle cx="16" cy="19" r="1"/></g>',
  };
  const SLEET = {
    1: '<path class="wx-rain" d="M10 17.5l-1 3"/><g class="wx-snow"><circle cx="14" cy="19.5" r="1"/></g>',
    2: '<path class="wx-rain" d="M9 17.5l-1 3"/><g class="wx-snow"><circle cx="13" cy="19.5" r="1"/></g><path class="wx-rain" d="M17 17.5l-1 3"/>',
    3: '<path class="wx-rain" d="M8 17.5l-1 3M16 17.5l-1 3"/><g class="wx-snow"><circle cx="12" cy="19.5" r="1"/></g>',
  };
  const BOLT = '<path class="wx-bolt" d="M13 15.5l-2.5 3.5h3l-2 3.5"/>';
  const FOG = '<path class="wx-cloud" d="M4 9h16M3 13h18M5 17h14"/>';

  function parts(symbol) {
    const s = String(symbol || "cloudy");
    const night = s.endsWith("_night") || s.endsWith("_polartwilight");
    const base = s.replace(/_(day|night|polartwilight)$/, "");
    if (base === "clearsky") return night ? MOON : SUN;
    if (base === "fair" || base === "partlycloudy") return (night ? SMALL_MOON : SMALL_SUN) + (base === "fair" ? CLOUD_LOW.replace("wx-cloud", "wx-cloud wx-light") : CLOUD_LOW);
    if (base === "cloudy") return CLOUD_FULL;
    if (base === "fog") return FOG;
    const thunder = base.endsWith("andthunder");
    const core = thunder ? base.slice(0, -10) : base;
    const level = core.startsWith("light") ? 1 : core.startsWith("heavy") ? 3 : 2;
    const showers = core.endsWith("showers");
    const fall = /snow/.test(core) ? FLAKES[level] : /sleet/.test(core) ? SLEET[level] : DROPS[level];
    const sky = showers ? (night ? SMALL_MOON : SMALL_SUN) + CLOUD_HIGH_PART : CLOUD_HIGH;
    return sky + (thunder ? BOLT : fall);
  }

  /** SVG-tekst for et værsymbol. */
  function icon(symbol, size = 32, label = "") {
    const a11y = label ? `role="img" aria-label="${label.replace(/"/g, "&quot;")}"` : 'aria-hidden="true"';
    return `<svg class="wx-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${parts(symbol)}</svg>`;
  }

  const TZ = "Europe/Oslo";
  const hourFmt = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", timeZone: TZ });
  const dayFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "long", timeZone: TZ });
  const dateKey = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

  const temp = (t) => `${Math.round(t) || 0}°`.replace("-", "\u2212");
  const hour = (iso) => hourFmt.format(new Date(iso));
  const mm = (n) => (n >= 0.1 ? `${n.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} mm` : "");

  /** «I dag», «I morgen» eller ukedagen for en dato som ÅÅÅÅ-MM-DD. */
  function dayName(date) {
    const today = dateKey.format(new Date());
    const tomorrow = dateKey.format(new Date(Date.now() + 86400_000));
    if (date === today) return "I dag";
    if (date === tomorrow) return "I morgen";
    const d = dayFmt.format(new Date(`${date}T12:00:00Z`));
    return d.charAt(0).toUpperCase() + d.slice(1);
  }

  window.Weather = { icon, temp, hour, mm, dayName };
})();
