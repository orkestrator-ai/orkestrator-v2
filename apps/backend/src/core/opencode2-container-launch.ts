/**
 * The container's OpenCode (2.x) server on an `opencode2-launch=1` image
 * (#2091; docs/architecture/agent-approvals.md).
 *
 * OpenCode loads plugins from every configuration directory it reads, at every
 * instance start, and a plugin runs inside the server, beside the password it
 * compares. Started from `node`'s login shell, 2.x ran node's own
 * `~/.opencode/bin/opencode2` with `OPENCODE_CONFIG_DIR` in node's home, read
 * the checkout's `.opencode/` and `opencode.json` (both can load a plugin
 * beside the password), and nothing checked who listened on its port.
 * Here instead:
 *
 * - a root exec rebuilds `/run/orkestrator-opencode2` before every start
 *   ({@link openCode2LaunchConfigScript}): `opencode/` is `OPENCODE_CONFIG_DIR`,
 *   which on 2.2.6 replaces the global directory, holding Orkestrator's two
 *   plugins and the user's configuration copied from the read-only host input
 *   `/opencode-config` and merged without plugins (`opencode2/user-config.ts`);
 *   `config/` (`XDG_CONFIG_HOME`) and `home/` (`OPENCODE_TEST_HOME`) are empty;
 *   `cache/` is the root-owned package cache, which root fills with the
 *   provider packages the user's configuration names (`opencode-package-cache.ts`);
 * - the node login shell only prepares and records its environment;
 * - `orkestrator-bridge-launch opencode2` starts the root-owned
 *   `/opt/opencode/bin/opencode2` under `env -i` with project configuration
 *   off, and the credential plugin applies the recorded environment for the
 *   server's tools;
 * - once the server answers the fresh password only it was given and has
 *   loaded its plugins, a root exec records its listening socket
 *   (`/run/orkestrator-bridge/opencode2-listener`), and every later read of
 *   the password checks the port's listener against it.
 *
 * Verified against the pinned 2.2.6 binary on 2026-11-10, outside a container:
 * with this environment a plugin planted in the checkout's `.opencode/plugins`,
 * `~/.config/opencode/plugins` or `~/.opencode/plugins` did not load and the
 * one in `OPENCODE_CONFIG_DIR` did; the configuration directory may be
 * read-only; the checkout's `AGENTS.md` returns through `OPENCODE_CONFIG_CONTENT`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import {
  OPENCODE2_LAUNCH_CONFIG_DIR,
  OPENCODE2_LAUNCH_CONFIG_HOME,
  OPENCODE2_LAUNCH_HOME,
  OPENCODE2_LAUNCH_ROOT,
} from "./agent-credential-files.js";
import { quoteShell } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import { OPENCODE2_SERVER_PORT } from "./constants.js";
import {
  launchContainerScript,
  type ContainerScriptLaunch,
} from "./container-bridge-credential.js";
import { keepPreviousLogCommand } from "./container-log-bounds.js";
import { CONTAINER_ROOT_USER_ARGS } from "./container-scripts.js";
import {
  OPENCODE2_DB_PATH,
  OPENCODE2_LEGACY_DB_PATH,
  OPENCODE_DB_DIRECTORY,
} from "./container-state-layout.js";
import {
  OPENCODE2_LISTENER_RECORD,
  recordOpenCodeListenerScript,
  stopOpenCodeListenersScript,
} from "./opencode-listener-identity.js";
import {
  openCodePackageCacheScript,
  OPENCODE_PACKAGE_CACHE_TIMEOUT_MS,
} from "./opencode-package-cache.js";
import { stageProjectOpenCodeConfig } from "./opencode-project-config.js";
import {
  OPENCODE2_CONTAINER_LOG,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
  OPENCODE2_CONTAINER_PROCESS_PATTERN,
  OPENCODE2_GITHUB_ENV_PLUGIN_ID,
  buildOpenCode2GitHubEnvironmentPluginSource,
  OPENCODE2_CREDENTIAL_PLUGIN_ID,
  OPENCODE2_DISABLE_FILEWATCHER,
  OPENCODE2_FLAGS,
  buildOpenCode2CredentialPluginSource,
  OPENCODE2_USER_CONFIG_MIRROR_FILE,
  buildOpenCode2UserConfigMergeCommand,
} from "./opencode2/index.js";
import { runCommand } from "./shell.js";

/**
 * The read-only mount of the user's host `~/.config/opencode`; root copies the
 * server's configuration from it, never from the container's copy of it,
 * which node can change.
 */
export const OPENCODE_HOST_CONFIG_INPUT = "/opencode-config";

/** A host configuration larger than this is not copied; OpenCode starts with ours alone. */
export const OPENCODE_HOST_CONFIG_MAX_KIB = 64 * 1024;

/** The plugins a launched 2.x server starts with, by id. */
export function openCode2LaunchPlugins(): ReadonlyArray<{ id: string; source: string }> {
  return [
    {
      id: OPENCODE2_CREDENTIAL_PLUGIN_ID,
      source: buildOpenCode2CredentialPluginSource({
        hardened: "refuse-tools",
        applyLaunchEnvironment: true,
      }),
    },
    { id: OPENCODE2_GITHUB_ENV_PLUGIN_ID, source: buildOpenCode2GitHubEnvironmentPluginSource() },
  ];
}

/** The image's Bun, run as root from `/` with no configuration or `.env` of the working directory. */
const ROOT_BUN = "/usr/local/bin/bun --config=/dev/null --no-env-file";

/**
 * Root shell that rebuilds the 2.x server's directories. Built beside the old
 * ones and moved into place, root-owned and readable by the server's uid. The
 * user's merged configuration is written in place afterwards, so a relative
 * `{file:}` reference resolves inside the final directory.
 */
export function openCode2LaunchConfigScript(): string {
  const plugins = openCode2LaunchPlugins();
  const config = OPENCODE2_LAUNCH_CONFIG_DIR;
  const merged = `${config}/.merged.jsonc`;
  return [
    "set -eu",
    "umask 022",
    `root=${OPENCODE2_LAUNCH_ROOT}`,
    // The image creates it root-owned; refuse anything else.
    `if [ ! -d "$root" ] || [ -L "$root" ] || [ "$(stat -c %u "$root")" != 0 ]; then echo "OpenCode 2's configuration root is missing" >&2; exit 70; fi`,
    `next=$(mktemp -d "$root/.config.XXXXXX")`,
    `trap 'rm -rf "$next"' EXIT`,
    `mkdir -p "$next/opencode" "$next/config" "$next/home"`,
    `input=${OPENCODE_HOST_CONFIG_INPUT}`,
    `if [ -d "$input" ] && [ ! -L "$input" ]; then`,
    `  size=$(du -sk --exclude=node_modules "$input" 2>/dev/null | cut -f1)`,
    `  if [ "\${size:-0}" -le ${OPENCODE_HOST_CONFIG_MAX_KIB} ]; then`,
    // Preserve relative file references as well as known OpenCode entries.
    // The input is the trusted read-only host configuration, never the checkout.
    `    tar -C "$input" --exclude=node_modules --exclude=./plugin --exclude=./plugins -cf - . 2>/dev/null | tar -C "$next/opencode" --no-same-owner --no-same-permissions -xf -`,
    `  else`,
    `    echo "OpenCode's host configuration is larger than ${OPENCODE_HOST_CONFIG_MAX_KIB} KiB; it was not copied" >&2`,
    `  fi`,
    `fi`,
    // A symlink could name a file node writes; a FIFO or device is no configuration.
    `find "$next" -mindepth 1 ! -type d ! -type f -exec rm -f {} +`,
    ...plugins.flatMap(({ id, source }) => [
      `mkdir -p "$next/opencode/plugins/${id}"`,
      `printf '%s' ${quoteShell(source)} > "$next/opencode/plugins/${id}/index.ts"`,
    ]),
    `chown -R 0:0 "$next"`,
    `chmod -R u=rwX,go=rX "$next"`,
    `rm -rf ${config} ${OPENCODE2_LAUNCH_CONFIG_HOME} ${OPENCODE2_LAUNCH_HOME}`,
    `mv "$next/opencode" ${config}`,
    `mv "$next/config" ${OPENCODE2_LAUNCH_CONFIG_HOME}`,
    `mv "$next/home" ${OPENCODE2_LAUNCH_HOME}`,
    `rmdir "$next"`,
    "trap - EXIT",
    // One merged document without plugins; the user's own files never reach
    // 2.x as they are, because a `plugin` key in them would be installed.
    "cd /",
    `if ${buildOpenCode2UserConfigMergeCommand(config, merged, quoteShell, ROOT_BUN)} 2>/dev/null && [ -f ${merged} ]; then`,
    `  chmod 644 ${merged}`,
    `  mv ${merged} ${config}/${OPENCODE2_USER_CONFIG_MIRROR_FILE}`,
    "else",
    `  rm -f ${merged} ${config}/${OPENCODE2_USER_CONFIG_MIRROR_FILE}`,
    "fi",
    `rm -f ${config}/config.json ${config}/opencode.json`,
  ].join("\n");
}

/**
 * Changes whenever a plugin source or the launch does, so a server started
 * from node's login shell, or with older plugins, is replaced.
 */
export const OPENCODE2_LAUNCH_FINGERPRINT = createHash("sha256")
  .update("opencode2-launch-v1\0")
  .update(JSON.stringify(openCode2LaunchPlugins()))
  .update("\0")
  .update(OPENCODE2_FLAGS)
  .digest("hex");

/** The node login shell's part: everything but the start, ending in the environment snapshot. */
export function openCode2LaunchPrepareScript(snapshot: string): string {
  return `
    set -e
    cd /workspace
    ${keepPreviousLogCommand(OPENCODE2_CONTAINER_LOG)}
    umask 077
    mkdir -p /tmp/orkestrator-ai
    printf '%s' ${quoteShell(OPENCODE2_LAUNCH_FINGERPRINT)} > ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE}
    source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
    orkestrator_source_runtime_env 2>/dev/null || true
    unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN
    env -0 > ${snapshot}
  `;
}

/** What {@link startOpenCode2WithLauncher} hands `launchContainerScript`. */
export function openCode2Launch(
  password: string,
  persistentDatabase: boolean,
): { launch: ContainerScriptLaunch; snapshot: string } {
  const snapshot = `/tmp/.orkestrator-bridge-env-opencode2-${randomBytes(16).toString("hex")}`;
  return {
    snapshot,
    launch: {
      rootCredential: { kind: "opencode2", token: password },
      launcher: {
        kind: "opencode2",
        snapshot,
        env: {
          OPENCODE_PASSWORD: password,
          OPENCODE_FLAGS: OPENCODE2_FLAGS,
          // Its location watchers stall start and shutdown (`server.ts`).
          ...OPENCODE2_DISABLE_FILEWATCHER,
          // 2.x always gets a database of its own: its default is 1.x's `opencode.db`.
          OPENCODE_DB: persistentDatabase ? OPENCODE2_DB_PATH : OPENCODE2_LEGACY_DB_PATH,
        },
      },
    },
  };
}

async function asRoot(containerId: string, script: string, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await runCommand(
    "docker",
    ["exec", ...CONTAINER_ROOT_USER_ARGS, containerId, "sh", "-c", script],
    { timeoutMs },
  );
  return stdout;
}

/**
 * Stop what listens on the 2.x port, whatever its command line (found as
 * `node`, which can read its own processes' descriptors), and any
 * `opencode2 serve`, and forget what it was started with.
 */
export async function stopOpenCode2Listeners(containerId: string): Promise<void> {
  await dockerExec(
    containerId,
    `${stopOpenCodeListenersScript(OPENCODE2_SERVER_PORT)}\npkill -f '${OPENCODE2_CONTAINER_PROCESS_PATTERN}' || true; rm -f ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE}`,
    30_000,
  );
}

/**
 * Record the 2.x port's listening socket as the server the backend launched.
 * Called once the server answered the fresh password, which only that process
 * was given, and loaded its plugins, which made it non-dumpable.
 */
export async function recordOpenCode2Listener(containerId: string): Promise<void> {
  const answer = (
    await asRoot(
      containerId,
      recordOpenCodeListenerScript(OPENCODE2_SERVER_PORT, OPENCODE2_LISTENER_RECORD),
    )
  )
    .trim()
    .split("\n")
    .at(-1);
  if (answer !== "recorded") {
    await stopOpenCode2Listeners(containerId).catch(() => undefined);
    throw new Error("OpenCode 2's server could not be identified on its port; it was stopped");
  }
}

/**
 * Write the configuration, the package cache and the project configuration as
 * root, prepare as node and start through the launcher. Returns the password;
 * the caller waits for the server, warms it and then calls
 * {@link recordOpenCode2Listener}.
 */
export async function startOpenCode2WithLauncher(containerId: string): Promise<string> {
  await asRoot(containerId, openCode2LaunchConfigScript());
  await asRoot(containerId, openCodePackageCacheScript(), OPENCODE_PACKAGE_CACHE_TIMEOUT_MS);
  await stageProjectOpenCodeConfig(containerId);
  const persistentDatabase =
    (
      await dockerExec(
        containerId,
        `if mountpoint -q ${OPENCODE_DB_DIRECTORY} 2>/dev/null; then echo mounted; fi`,
      )
    ).trim() === "mounted";
  const password = mintBridgeToken();
  const { launch, snapshot } = openCode2Launch(password, persistentDatabase);
  await launchContainerScript(containerId, openCode2LaunchPrepareScript(snapshot), launch);
  return password;
}
