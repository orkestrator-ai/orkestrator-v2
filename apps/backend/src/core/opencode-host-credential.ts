import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  const staged = `${plugin}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, buildOpenCodeCredentialPluginSource("log"), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(staged, plugin);
  } finally {
    await rm(staged, { force: true });
  }
  return directory;
}
