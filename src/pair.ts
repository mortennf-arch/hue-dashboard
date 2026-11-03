import { hostname } from "node:os";
import { saveConfig, configPath, type BridgeConfig } from "./config.js";
import { PinnedAgent, bridgeRequest, readBridgeCertificate } from "./hue-client.js";

interface DiscoveredBridge {
  id?: string;
  ip: string;
}

/**
 * Finner broen. En fast IP i HUE_BRIDGE_IP (eller --ip) går foran.
 * Ellers spør vi Signify sin oppslagstjeneste, som returnerer broer på samme offentlige IP.
 * mDNS brukes ikke, fordi det ofte ikke virker inne i en Docker-container.
 */
export async function discoverBridge(explicitIp?: string): Promise<DiscoveredBridge> {
  const ip = explicitIp ?? process.env.HUE_BRIDGE_IP;
  if (ip) return { ip };

  console.log("Leter etter broen via discovery.meethue.com ...");
  let list: { id: string; internalipaddress: string }[];
  try {
    const res = await fetch("https://discovery.meethue.com/", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = (await res.json()) as typeof list;
  } catch (err) {
    throw new Error(
      `Fant ikke broen automatisk (${(err as Error).message}). ` +
        "Finn IP-adressen i Hue-appen (Innstillinger > Hue Bridges > i) og kjør på nytt med HUE_BRIDGE_IP=<ip>.",
    );
  }
  if (list.length === 0) {
    throw new Error(
      "Oppslagstjenesten fant ingen bro på nettverket ditt. Sett HUE_BRIDGE_IP=<ip> og prøv igjen.",
    );
  }
  if (list.length > 1) {
    console.log(
      `Fant ${list.length} broer: ${list.map((b) => b.internalipaddress).join(", ")}. Bruker den første. ` +
        "Sett HUE_BRIDGE_IP for å velge en annen.",
    );
  }
  return { id: list[0].id, ip: list[0].internalipaddress };
}

type PairResponse = Array<{
  success?: { username: string; clientkey?: string };
  error?: { type: number; description: string };
}>;

const LINK_BUTTON_NOT_PRESSED = 101;

/**
 * Parer med broen: venter til noen trykker på knappen, og lagrer nøkkelen i data/config.json.
 * timeoutMs = 0 betyr at vi venter for alltid (brukes i Docker, der du trykker når du ser loggen).
 */
export async function pair(opts: { ip?: string; timeoutMs?: number } = {}): Promise<BridgeConfig> {
  const bridge = await discoverBridge(opts.ip);
  console.log(`Kobler til broen på ${bridge.ip} ...`);

  const cert = await readBridgeCertificate(bridge.ip);
  if (bridge.id && cert.commonName && cert.commonName.toLowerCase() !== bridge.id.toLowerCase()) {
    throw new Error(
      `Sertifikatet på ${bridge.ip} tilhører ${cert.commonName}, ikke broen ${bridge.id}. Avbryter.`,
    );
  }
  const agent = new PinnedAgent(cert.fingerprint256);

  try {
    const info = await bridgeRequest<{ name?: string; bridgeid?: string; modelid?: string; swversion?: string }>(
      { ip: bridge.ip, agent, path: "/api/0/config" },
    );
    console.log(
      `Fant broen «${info.name ?? "ukjent"}» (id ${info.bridgeid ?? "?"}, modell ${info.modelid ?? "?"}, programvare ${info.swversion ?? "?"}).`,
    );

    const devicetype = `hue_dashboard#${hostname().slice(0, 19)}`;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const started = Date.now();
    let lastHint = 0;

    console.log("");
    console.log("  >>> Trykk på den runde knappen midt på Hue-broen nå. <<<");
    console.log("");

    for (;;) {
      const res = await bridgeRequest<PairResponse>({
        ip: bridge.ip,
        agent,
        method: "POST",
        path: "/api",
        body: { devicetype, generateclientkey: true },
      });
      const first = res[0];
      if (first?.success) {
        const cfg: BridgeConfig = {
          bridgeIp: bridge.ip,
          bridgeId: info.bridgeid?.toLowerCase() ?? cert.commonName.toLowerCase(),
          appKey: first.success.username,
          clientKey: first.success.clientkey,
          certFingerprint256: cert.fingerprint256,
          pairedAt: new Date().toISOString(),
        };
        await saveConfig(cfg);
        console.log(`Paret! Nøkkelen er lagret i ${configPath}. Ikke del denne filen.`);
        return cfg;
      }
      if (first?.error && first.error.type !== LINK_BUTTON_NOT_PRESSED) {
        throw new Error(`Broen avviste paringen: ${first.error.description}`);
      }
      const waited = Date.now() - started;
      if (timeoutMs > 0 && waited > timeoutMs) {
        throw new Error("Knappen ble ikke trykket i tide. Kjør på nytt og trykk på knappen.");
      }
      if (waited - lastHint >= 15_000) {
        lastHint = waited;
        console.log(`Venter på knappetrykk ... (${Math.round(waited / 1000)} s)`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    agent.destroy();
  }
}
