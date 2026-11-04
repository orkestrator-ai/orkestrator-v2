import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Whether a local window created now takes backend events and commands over
 * the gateway directly instead of through main's relay (the
 * `localWindowGatewayTransport` setting in `config.json`). Off when the file
 * cannot be read or parsed, which keeps the relay every release has shipped.
 */
export function readLocalWindowGatewayTransport(dataDir: string): boolean {
  try {
    const config = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")) as {
      global?: { localWindowGatewayTransport?: unknown };
    } | null;
    return config?.global?.localWindowGatewayTransport === true;
  } catch {
    return false;
  }
}
