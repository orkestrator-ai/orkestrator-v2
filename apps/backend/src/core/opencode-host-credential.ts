import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  const pluginDirectory = hostOpenCodePluginDirectory(directory);
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

function hostOpenCodePluginDirectory(configDirectory: string): string {
  return path.join(configDirectory, "plugins");
}

/** How a host OpenCode server was given Orkestrator's plugins. */
export type HostOpenCodePluginInstallation =
  /** `OPENCODE_CONFIG_DIR` names Orkestrator's directory. */
  | { mode: "config-dir" }
  /** The user's `OPENCODE_CONFIG_DIR` is kept; the plugins ride in `OPENCODE_CONFIG_CONTENT`. */
  | { mode: "config-content" }
  /** Neither was possible, and the server is not a coordinator's. */
  | { mode: "skipped"; reason: "config-content-unusable" };

/**
 * Refused rather than started: a coordinator's OpenCode server would run
 * without its data-directory read check. The message is content-free.
 */
export class OpenCodeCoordinatorReadBoundaryUnavailableError extends Error {
  constructor() {
    super(
      "A coordinator's OpenCode server could not load its read-boundary plugin: OPENCODE_CONFIG_CONTENT in the backend's environment is not a JSON object whose `plugin` entry is a list of strings. Fix or unset it where the backend is started.",
    );
    this.name = "OpenCodeCoordinatorReadBoundaryUnavailableError";
  }
}

/**
 * The user's `OPENCODE_CONFIG_CONTENT`, as an object this launcher can add a
 * `plugin` entry to, or null when it is not one. OpenCode reads it as JSONC
 * and substitutes `{env:…}` and `{file:…}` in the text; re-serialising keeps
 * those tokens as the same strings, so the substitution still happens.
 */
function userOpenCodeConfigContent(text: string | undefined): Record<string, unknown> | null {
  if (!text?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const plugin = (parsed as Record<string, unknown>).plugin;
  if (
    plugin !== undefined &&
    !(Array.isArray(plugin) && plugin.every((entry) => typeof entry === "string"))
  ) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Gives a host OpenCode 1.x server Orkestrator's plugins: the credential
 * plugin and the coordinator's data-directory read check.
 *
 * Normally through `OPENCODE_CONFIG_DIR`. OpenCode honours only one such
 * directory, though, so when the backend's own environment already names the
 * user's, replacing it would drop their configuration. The plugins are then
 * added as absolute `file://` entries of `OPENCODE_CONFIG_CONTENT`'s `plugin`
 * list, which OpenCode 1.19.5 appends to the plugins of every other
 * configuration source rather than replacing them (qualified offline in
 * `opencode-coordinator-read-boundary-live.test.ts`).
 *
 * When even that is impossible — the user's own `OPENCODE_CONFIG_CONTENT` is
 * not an object with a list of plugin strings, so it cannot be extended
 * without guessing — a coordinator's server is refused, because it would run
 * without its read check; any other server starts without the plugins, as it
 * always has. Never logs the content: it may carry secrets.
 */
export async function installHostOpenCodePlugins(
  env: Record<string, string | undefined>,
  dataDir: string,
  { coordinator }: { coordinator: boolean },
): Promise<HostOpenCodePluginInstallation> {
  if (!env.OPENCODE_CONFIG_DIR?.trim()) {
    env.OPENCODE_CONFIG_DIR = await writeHostOpenCodeCredentialPlugin(dataDir);
    return { mode: "config-dir" };
  }
  const content = userOpenCodeConfigContent(env.OPENCODE_CONFIG_CONTENT);
  if (!content) {
    if (coordinator) throw new OpenCodeCoordinatorReadBoundaryUnavailableError();
    return { mode: "skipped", reason: "config-content-unusable" };
  }
  const pluginDirectory = hostOpenCodePluginDirectory(
    await writeHostOpenCodeCredentialPlugin(dataDir),
  );
  const ours = [OPENCODE_CREDENTIAL_PLUGIN_FILE, OPENCODE_READ_BOUNDARY_PLUGIN_FILE].map(
    (file) => pathToFileURL(path.join(pluginDirectory, file)).href,
  );
  const existing = (content.plugin as string[] | undefined) ?? [];
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...content,
    plugin: [...new Set([...existing, ...ours])],
  });
  return { mode: "config-content" };
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
