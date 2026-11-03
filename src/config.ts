import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Det som lagres etter at broen er paret. Filen inneholder API-nøkkelen, så den skal aldri i git. */
export interface BridgeConfig {
  bridgeIp: string;
  bridgeId?: string;
  /** "username" fra paringen, sendes som headeren hue-application-key. */
  appKey: string;
  /** Brukes bare til Entertainment-strømming, men lagres for senere. */
  clientKey?: string;
  /** SHA-256-fingeravtrykk av broens sertifikat, lagret første gang vi koblet til. */
  certFingerprint256: string;
  pairedAt: string;
}

/** Mappen der config.json og hendelseslogg lagres. I Docker settes DATA_DIR=/data. */
export const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
const configPath = path.join(dataDir, "config.json");

export async function loadConfig(): Promise<BridgeConfig | null> {
  try {
    const raw = await readFile(configPath, "utf8");
    const cfg = JSON.parse(raw) as BridgeConfig;
    if (!cfg.bridgeIp || !cfg.appKey || !cfg.certFingerprint256) return null;
    // Lar en fast IP fra miljøet overstyre den lagrede, i tilfelle broen har flyttet.
    if (process.env.HUE_BRIDGE_IP) cfg.bridgeIp = process.env.HUE_BRIDGE_IP;
    return cfg;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(cfg: BridgeConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, configPath);
}

export { configPath };
