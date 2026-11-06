import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildOpenCodeCredentialPluginSource,
  OPENCODE_CREDENTIAL_PLUGIN_FILE,
} from "./agent-credential-files.js";
import {
  buildOpenCodeReadBoundaryPluginSource,
  OPENCODE_READ_BOUNDARY_PLUGIN_FILE,
} from "./opencode-read-boundary-plugin.js";

/**
 * The `OPENCODE_CONFIG_DIR` that gives a host OpenCode server its credential
 * plugin and, for a coordinator's server, its data-directory read check (inert
 * in every other server). Every local server shares it, and OpenCode installs
 * its plugin SDK there once. Only the user's own configuration is left to it
 * otherwise: this directory adds to it without replacing anything.
 */
export async function writeHostOpenCodeCredentialPlugin(dataDir: string): Promise<string> {
  const directory = path.join(dataDir, "opencode-host-config");
  const pluginDirectory = path.join(directory, "plugins");
  await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
  await writePlugin(
    path.join(pluginDirectory, OPENCODE_CREDENTIAL_PLUGIN_FILE),
    buildOpenCodeCredentialPluginSource("log"),
  );
  await writePlugin(
    path.join(pluginDirectory, OPENCODE_READ_BOUNDARY_PLUGIN_FILE),
    buildOpenCodeReadBoundaryPluginSource(),
  );
  return directory;
}

async function writePlugin(plugin: string, source: string): Promise<void> {
  // A server starting alongside this one must never load half a file.
  const staged = `${plugin}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, source, { mode: 0o600, flag: "wx" });
    await rename(staged, plugin);
  } finally {
    await rm(staged, { force: true });
  }
}
