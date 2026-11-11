import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Whether a local window created now takes backend events and commands over
 * the gateway directly instead of through main's relay (the
 * `localWindowGatewayTransport` setting in `config.json`).
 *
 * On unless the config says `false` (to-do 4501 task 2): a missing setting, a
 * missing or unreadable file, or a fresh install all get the direct transport.
 * An explicit `false`, which a release before the flip wrote when its user
 * turned the setting off, keeps the relay, so that choice survives the flip.
 * Settings shows the same default (`GlobalSettings.tsx`).
 */
export function readLocalWindowGatewayTransport(dataDir: string): boolean {
  try {
    const config = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")) as {
      global?: { localWindowGatewayTransport?: unknown };
    } | null;
    return config?.global?.localWindowGatewayTransport !== false;
  } catch {
    return true;
  }
}
