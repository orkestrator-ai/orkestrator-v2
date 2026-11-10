/**
 * The container's OpenCode 1.x server on an `opencode-launch=1` image.
 *
 * OpenCode loads plugins from every configuration directory it reads, at every
 * instance start, and a plugin runs inside the server, beside the password it
 * compares. Started from `node`'s login shell, it read `~/.config/opencode`,
 * `~/.opencode`, `/workspace/.opencode` and the `plugin` key of the project's
 * `opencode.json`, all of which the agent's uid can write, and ran a binary
 * from node's own home. Here instead:
 *
 * - a root exec rebuilds `/run/orkestrator-opencode` before every start
 *   ({@link openCodeLaunchConfigScript}): the user's own global configuration,
 *   copied from the read-only host input `/opencode-config` (never from the
 *   container's copy of it, which node can change), with symlinks and special
 *   files dropped, and Orkestrator's two plugins;
 * - the node login shell only prepares: it records the environment it built,
 *   as for a bridge;
 * - `orkestrator-bridge-launch opencode` starts the root-owned
 *   `/opt/opencode/bin/opencode` under `env -i`, with `XDG_CONFIG_HOME` and
 *   `OPENCODE_TEST_HOME` in that directory and project configuration off; the
 *   credential plugin applies the recorded environment for the server's tools;
 * - once the server answers the fresh password only it was given, a root exec
 *   records which process it is (`opencode-listener-identity.ts`), and every
 *   later read of the password checks the port's listener against it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import {
  buildOpenCodeCredentialPluginSource,
  OPENCODE_CREDENTIAL_PLUGIN_FILE,
  OPENCODE_GITHUB_ENV_PLUGIN_FILE,
  OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE,
  OPENCODE_GITHUB_ENV_PLUGIN_SOURCE,
  OPENCODE_LAUNCH_CONFIG_HOME,
  OPENCODE_LAUNCH_HOME,
  OPENCODE_LAUNCH_ROOT,
} from "./agent-credential-files.js";
import { quoteShell } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import { OPENCODE_SERVER_PORT } from "./constants.js";
import {
  CONTAINER_TOKEN_FILES,
  launchContainerScript,
  type ContainerScriptLaunch,
} from "./container-bridge-credential.js";
import { keepPreviousLogCommand } from "./container-log-bounds.js";
import { CONTAINER_ROOT_USER_ARGS } from "./container-scripts.js";
import { OPENCODE_DB_DIRECTORY, OPENCODE_DB_PATH } from "./container-state-layout.js";
import {
  recordOpenCodeListenerScript,
  stopOpenCodeListenersScript,
} from "./opencode-listener-identity.js";
import { runCommand } from "./shell.js";

/** The credential plugin of a launched server, which also applies the start environment. */
export const OPENCODE_LAUNCH_CREDENTIAL_PLUGIN_SOURCE = buildOpenCodeCredentialPluginSource(
  "refuse-tools",
  { applyLaunchEnvironment: true },
);

/**
 * What a launched server's fingerprint file holds: both plugins and the
 * launch itself, so a server an older backend started in node's login shell,
 * or with older plugins, is replaced rather than reused.
 */
export const OPENCODE_LAUNCH_FINGERPRINT = createHash("sha256")
  .update("opencode-launch-v1\0")
  .update(OPENCODE_GITHUB_ENV_PLUGIN_SOURCE)
  .update("\0")
  .update(OPENCODE_LAUNCH_CREDENTIAL_PLUGIN_SOURCE)
  .digest("hex");

/** The read-only mount of the user's host `~/.config/opencode`. */
export const OPENCODE_HOST_CONFIG_INPUT = "/opencode-config";

/** A host configuration larger than this is not copied; OpenCode starts with ours alone. */
export const OPENCODE_HOST_CONFIG_MAX_KIB = 64 * 1024;

const OPENCODE_LOG = "/tmp/opencode-serve.log";

/**
 * Root shell that rebuilds the server's configuration directory and its empty
 * home. Built beside the old one and renamed into place, root-owned and not
 * writable by anyone else. `node_modules` is not copied: it holds packages
 * for the host's platform, and nothing may be installed into a directory node
 * cannot write, so a user plugin with dependencies of its own does not load.
 */
export function openCodeLaunchConfigScript(): string {
  const plugins = `"$next"/opencode/plugins`;
  return [
    "set -eu",
    "umask 022",
    `root=${OPENCODE_LAUNCH_ROOT}`,
    // The image creates it root-owned; refuse anything else.
    `if [ ! -d "$root" ] || [ -L "$root" ] || [ "$(stat -c %u "$root")" != 0 ]; then echo "OpenCode's configuration root is missing" >&2; exit 70; fi`,
    `next=$(mktemp -d "$root/.config.XXXXXX")`,
    `trap 'rm -rf "$next"' EXIT`,
    `mkdir -p ${plugins}`,
    `input=${OPENCODE_HOST_CONFIG_INPUT}`,
    `if [ -d "$input" ] && [ ! -L "$input" ]; then`,
    `  size=$(du -sk --exclude=node_modules "$input" 2>/dev/null | cut -f1)`,
    `  if [ "\${size:-0}" -le ${OPENCODE_HOST_CONFIG_MAX_KIB} ]; then`,
    `    tar -C "$input" --exclude=node_modules -cf - . 2>/dev/null | tar -C "$next"/opencode --no-same-owner --no-same-permissions -xf - || true`,
    `  else`,
    `    echo "OpenCode's host configuration is larger than ${OPENCODE_HOST_CONFIG_MAX_KIB} KiB; it was not copied" >&2`,
    `  fi`,
    `fi`,
    // A symlink could name a file node writes; a FIFO or device is no configuration.
    `find "$next" -mindepth 1 ! -type d ! -type f -exec rm -f {} +`,
    `mkdir -p ${plugins}`,
    `printf '%s' ${quoteShell(OPENCODE_LAUNCH_CREDENTIAL_PLUGIN_SOURCE)} > ${plugins}/${OPENCODE_CREDENTIAL_PLUGIN_FILE}`,
    `printf '%s' ${quoteShell(OPENCODE_GITHUB_ENV_PLUGIN_SOURCE)} > ${plugins}/${OPENCODE_GITHUB_ENV_PLUGIN_FILE}`,
    `chown -R 0:0 "$next"`,
    `chmod -R u=rwX,go=rX "$next"`,
    `rm -rf "$root/config" "$root/home"`,
    `mv "$next" ${OPENCODE_LAUNCH_CONFIG_HOME}`,
    "trap - EXIT",
    `mkdir -m 755 ${OPENCODE_LAUNCH_HOME}`,
  ].join("\n");
}

/** The node login shell's part: everything but the start, ending in the environment snapshot. */
export function openCodeLaunchPrepareScript(snapshot: string): string {
  return `
    set -e
    cd /workspace
    ${keepPreviousLogCommand(OPENCODE_LOG)}
    umask 077
    mkdir -p /tmp/orkestrator-ai
    rm -f ${CONTAINER_TOKEN_FILES.opencode}
    printf '%s' ${quoteShell(OPENCODE_LAUNCH_FINGERPRINT)} > ${OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE}
    source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
    orkestrator_source_runtime_env 2>/dev/null || true
    unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN
    env -0 > ${snapshot}
  `;
}

/** What `startOpenCodeWithLauncher` hands {@link launchContainerScript}. */
export function openCodeLaunch(
  password: string,
  persistentDatabase: boolean,
): { launch: ContainerScriptLaunch; snapshot: string } {
  const snapshot = `/tmp/.orkestrator-bridge-env-opencode-${randomBytes(16).toString("hex")}`;
  return {
    snapshot,
    launch: {
      rootCredential: { kind: "opencode", token: password },
      launcher: {
        kind: "opencode",
        snapshot,
        env: {
          OPENCODE_SERVER_PASSWORD: password,
          ...(persistentDatabase ? { OPENCODE_DB: OPENCODE_DB_PATH } : {}),
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
 * Stop what listens on OpenCode's port: the agent's uid's processes holding
 * it, found as `node` (container root cannot read their descriptors), and any
 * `opencode serve`.
 */
export async function stopOpenCodeListeners(containerId: string): Promise<void> {
  await dockerExec(
    containerId,
    `${stopOpenCodeListenersScript(OPENCODE_SERVER_PORT)}\npkill -f '[o]pencode serve' || true`,
    30_000,
  );
}

/**
 * Record the port's listening socket as the server the backend launched.
 * Called once the server answered the fresh password, which only that process
 * was given, and loaded its plugins, which made it non-dumpable.
 */
export async function recordOpenCodeListener(containerId: string): Promise<void> {
  const answer = (await asRoot(containerId, recordOpenCodeListenerScript(OPENCODE_SERVER_PORT)))
    .trim()
    .split("\n")
    .at(-1);
  if (answer !== "recorded") {
    await stopOpenCodeListeners(containerId).catch(() => undefined);
    throw new Error("OpenCode's server could not be identified on its port; it was stopped");
  }
}

/**
 * Write the configuration, prepare as node and start through the launcher.
 * Returns the password; the caller waits for health and then calls
 * {@link recordOpenCodeListener}.
 */
export async function startOpenCodeWithLauncher(containerId: string): Promise<string> {
  await asRoot(containerId, openCodeLaunchConfigScript());
  const persistentDatabase =
    (
      await dockerExec(
        containerId,
        `if mountpoint -q ${OPENCODE_DB_DIRECTORY} 2>/dev/null; then echo mounted; fi`,
      )
    ).trim() === "mounted";
  const password = mintBridgeToken();
  const { launch, snapshot } = openCodeLaunch(password, persistentDatabase);
  await launchContainerScript(containerId, openCodeLaunchPrepareScript(snapshot), launch);
  return password;
}
