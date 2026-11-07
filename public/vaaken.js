// Holder skjermen våken mens siden er åpen og synlig, så nettbrettet ikke dimmer eller slukker.
// Bruker Screen Wake Lock i nettleseren. Den slippes når fanen skjules, så vi ber om den igjen
// når siden blir synlig. Virker bare på https eller en adresse nettleseren regner som sikker.
(() => {
  if (!("wakeLock" in navigator)) return;
  let lock = null;
  let asking = false;

  async function ask() {
    if (lock || asking || document.visibilityState !== "visible") return;
    asking = true;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        lock = null;
      });
    } catch {
      // Nektet (for eksempel lite batteri eller usikker adresse). Prøver igjen ved neste trykk.
    } finally {
      asking = false;
    }
  }

  document.addEventListener("visibilitychange", ask);
  // Noen nettlesere krever at brukeren har trykket på siden først.
  document.addEventListener("pointerdown", ask, { passive: true });
  ask();
  // Sjekk av og til i tilfelle låsen ble sluppet uten at vi fikk beskjed.
  setInterval(ask, 60_000);
})();
