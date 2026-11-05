import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildOpenCodeCredentialPluginSource,
  OPENCODE_CREDENTIAL_PLUGIN_FILE,
} from "./agent-credential-files.js";

/**
 * The `OPENCODE_CONFIG_DIR` that gives a host OpenCode server its credential
 * plugin. Every local server shares it, and OpenCode installs its plugin SDK
 * there once. Only the user's own configuration is left to it otherwise: this
 * directory adds to it without replacing anything.
 */
export async function writeHostOpenCodeCredentialPlugin(dataDir: string): Promise<string> {
  const directory = path.join(dataDir, "opencode-host-config");
  const pluginDirectory = path.join(directory, "plugins");
  await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
  const plugin = path.join(pluginDirectory, OPENCODE_CREDENTIAL_PLUGIN_FILE);
  // A server starting alongside this one must never load half a file.
  const staged = `${plugin}.${process.pid}.tmp`;
  await writeFile(staged, buildOpenCodeCredentialPluginSource("log"), { mode: 0o600 });
  await rename(staged, plugin);
  return directory;
}
