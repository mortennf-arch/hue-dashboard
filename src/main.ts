import { loadConfig, configPath } from "./config.js";
import { pair } from "./pair.js";
import { watch } from "./watch.js";

const USAGE = `Bruk:
  npm run dev          Parer hvis nødvendig, starter dashbordet og viser hendelser live
  npm run pair         Parer med broen på nytt (trykk på knappen når du blir bedt om det)
  npm run watch        Viser bare tilstand og hendelser i terminalen, uten dashbord

Valg:
  --ip <adresse>       Bruk denne IP-adressen til broen i stedet for å lete
Miljøvariabler:
  HUE_BRIDGE_IP        Samme som --ip
  SONOS_IP             Adressen til én (eller flere, kommaseparert) Sonos-høyttaler. Uten den letes det på nettet
  SONOS                Sett til «off» for å skru av Sonos-delen
  SPOTIFY_CLIENT_ID    Nøkler fra developer.spotify.com, for å søke i Spotify fra dashbordet
  SPOTIFY_CLIENT_SECRET
  VERISURE_USERNAME    E-post og passord til Verisure-appen, for alarmstatus, dører, temperatur og logg (bare lesing)
  VERISURE_PASSWORD
  PORT                 Porten dashbordet svarer på (standard: 8095)
  DATA_DIR             Hvor config.json og logger lagres (standard: ./data)
  PAIR_TIMEOUT_S       Hvor lenge paringen venter på knappetrykk. 0 = for alltid (standard: 60)`;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv.slice(2).find((a) => !a.startsWith("-") && a !== argValue("--ip")) ?? "run";
  const ip = argValue("--ip");
  const timeoutMs = Number(process.env.PAIR_TIMEOUT_S ?? 60) * 1000;

  switch (command) {
    case "pair":
      await pair({ ip, timeoutMs });
      return;
    case "watch": {
      const cfg = await loadConfig();
      if (!cfg) throw new Error(`Fant ingen paret bro i ${configPath}. Kjør «npm run pair» først.`);
      await watch(cfg);
      return;
    }
    case "run": {
      const cfg = (await loadConfig()) ?? (await pair({ ip, timeoutMs }));
      await watch(cfg, { web: { port: Number(process.env.PORT ?? 8095) } });
      return;
    }
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(`Ukjent kommando «${command}».\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`\nFeil: ${err.message}`);
  process.exitCode = 1;
});
