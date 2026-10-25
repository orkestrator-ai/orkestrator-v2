import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NodeImportEntry } from "@orkestrator/protocol/command-nodes";
import { isProvisionalBackendId } from "@orkestrator/protocol/federation";

import type { SavedMachineExport } from "./connection-manager.js";

/**
 * One-time upgrade step: the machines saved in this desktop's device
 * catalogue become leaves of the desktop's local command node.
 *
 * The local backend keeps the registry (and so the credentials) from then
 * on. The catalogue itself is left untouched, as the downgrade path and as
 * the list of targets this desktop can still connect to directly. A marker
 * file makes this run once; the backend also refuses to import a catalogue
 * entry twice, so a forgotten node is never re-added.
 */

export const COMMAND_NODE_IMPORT_MARKER = "command-node-import.json";

export interface CommandNodeImportResult {
  imported: number;
  skipped: number;
  needsCredential: number;
}

export async function importSavedMachinesOnce(options: {
  connectionsDir: string;
  machines: () => Promise<SavedMachineExport[]>;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
}): Promise<CommandNodeImportResult | "already-imported"> {
  const marker = path.join(options.connectionsDir, COMMAND_NODE_IMPORT_MARKER);
  if (
    await readFile(marker, "utf8").then(
      () => true,
      () => false,
    )
  ) {
    return "already-imported";
  }
  const machines = await options.machines();
  const entries = machines.map(savedMachineImportEntry);
  const result =
    entries.length === 0
      ? { imported: 0, skipped: 0, needsCredential: 0 }
      : ((await options.invoke("import_desktop_connections", {
          entries,
        })) as CommandNodeImportResult);
  await mkdir(options.connectionsDir, { recursive: true, mode: 0o700 });
  const temporary = `${marker}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, importedAt: (options.now?.() ?? new Date()).toISOString(), ...result })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, marker);
  return result;
}

/** A saved machine as a command node's registry receives it, token included. */
export function savedMachineImportEntry({ backend, token }: SavedMachineExport): NodeImportEntry {
  const verified =
    backend.verifiedInstallationId && !isProvisionalBackendId(backend.verifiedInstallationId)
      ? backend.verifiedInstallationId
      : undefined;
  return {
    importedFrom: backend.id,
    fallbackName: (backend.localAlias ?? backend.fallbackName).slice(0, 64) || "Machine",
    ...(verified ? { verifiedNodeId: verified } : {}),
    routes: backend.routes.map((route) =>
      route.kind === "https"
        ? { id: route.id, kind: "https" as const, enabled: route.enabled, origin: route.origin }
        : {
            id: route.id,
            kind: "ssh" as const,
            enabled: route.enabled,
            destination: route.destination,
            ...(route.sshPort ? { sshPort: route.sshPort } : {}),
            ...(route.identityFile ? { identityFile: route.identityFile } : {}),
            remoteGatewayPort: route.remoteGatewayPort,
          },
    ),
    routeOrder: backend.routeOrder,
    token,
    enabled: backend.autoConnect,
    ...(backend.profileCache ? { profileCache: backend.profileCache } : {}),
  };
}
