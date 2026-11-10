/**
 * How an OpenCode 2.x server is started inside a container
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phases 2 and 3).
 * Pure: the start script, the plugins it writes and what decides whether an
 * image runs 2.x. `opencode2-container-server.ts` drives Docker with them.
 *
 * This is the login-shell start of an image without `opencode2-launch=1`. On
 * a newer image the root-owned launcher starts 2.x instead
 * (`opencode2-container-launch.ts`), because this start runs node's own
 * binary and loads configuration node can write (to-do 7550).
 *
 * - **Only images that carry it.** `opencode2` is in the image manifest
 *   (`agents.opencode2`) of every image built since the 2.x pin; an older
 *   image, or a container created before {@link OPENCODE2_SERVER_PORT} was
 *   published, stays on 1.x.
 * - **Its own port and database.** A second fixed container port, and
 *   `OPENCODE_DB` beside 1.x's on the persistent `opencode/db` mount
 *   (`persistentStateExports("opencode2")`), never 1.x's `opencode.db`, which
 *   2.x would migrate in place.
 * - **The password as 1.x's is passed.** On stdin to a root-only file and, in
 *   the server's environment alone, to the server; the credential plugin
 *   removes it from the process and every shell, marks the server
 *   non-dumpable and refuses tools when it cannot.
 * - **The managed GitHub token in shells.** The 2.x form of the 1.x
 *   `shell.env` plugin: each shell reads the token file when it is created, so
 *   a token synced later reaches the next shell without a restart, and the
 *   server itself never holds one.
 * - **The user's global configuration, mirrored.** As on the host
 *   (`user-config.ts`): the container's `~/.config/opencode` (the
 *   entrypoint's copy of the host's) is mirrored into the 2.x config
 *   directory without plugins, by the image's Bun, on every start.
 * - **Pinned behaviour.** `OPENCODE_DISABLE_AUTOUPDATE` and the explicit
 *   {@link OPENCODE2_FLAGS}, as on the host.
 */
import { createHash } from "node:crypto";
import { OPENCODE2_SERVER_PORT } from "../constants.js";
import { CONTAINER_GITHUB_CREDENTIAL_FILE } from "../agent-credential-files.js";
import { quoteShell } from "../commands-agent-support.js";
import { boundedLaunchWithPrivateEnv, keepPreviousLogCommand } from "../container-log-bounds.js";
import { persistentStateExports } from "../container-state-layout.js";
import {
  OPENCODE2_CREDENTIAL_PLUGIN_ID,
  OPENCODE2_FLAGS,
  buildOpenCode2CredentialPluginSource,
} from "./server.js";
import { buildOpenCode2ContainerUserConfigScript } from "./user-config.js";

/** The image's 2.x binary (`OPENCODE2_CLI_PATH` in `docker/Dockerfile`). */
export const OPENCODE2_CONTAINER_CLI_PATH = "/home/node/.opencode/bin/opencode2";
export const OPENCODE2_CONTAINER_LOG = "/tmp/opencode2-serve.log";
/**
 * `OPENCODE_CONFIG_DIR`, which replaces 2.x's global config directory: Orkestrator's
 * plugins and the mirror of the user's configuration.
 */
export const OPENCODE2_CONTAINER_CONFIG_DIR = "/home/node/.config/orkestrator-opencode2";
export const OPENCODE2_GITHUB_ENV_PLUGIN_ID = "orkestrator-github-env";
/** Records which plugin sources the running server was started with. */
export const OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/opencode2-plugins-fingerprint";
/** Matches the server's command line and not 1.x's `opencode serve`, nor the shell carrying it. */
export const OPENCODE2_CONTAINER_PROCESS_PATTERN = "[o]pencode2 serve";
export const OPENCODE2_CONTAINER_DIRECTORY = "/workspace";

export function openCode2ContainerPluginPath(id: string): string {
  return `${OPENCODE2_CONTAINER_CONFIG_DIR}/plugins/${id}/index.ts`;
}

/**
 * The 2.x form of `buildOpenCodeGitHubEnvironmentPluginSource`: every shell
 * the server creates gets `GITHUB_TOKEN` and `GH_TOKEN` from the managed
 * token file, read when the shell is created. A missing or empty file adds
 * nothing. `node:fs` is built into the binary, so nothing is installed.
 */
export function buildOpenCode2GitHubEnvironmentPluginSource(
  credentialFile = CONTAINER_GITHUB_CREDENTIAL_FILE,
): string {
  return `// Written by Orkestrator. Gives this server's shells the managed GitHub token.
import { readFile } from "node:fs/promises";

const credentialFile = ${JSON.stringify(credentialFile)};

export default {
  id: ${JSON.stringify(OPENCODE2_GITHUB_ENV_PLUGIN_ID)},
  async setup(ctx) {
    await ctx.shell.hook("create.before", async (event) => {
      let token = "";
      try {
        token = (await readFile(credentialFile, "utf8")).trim();
      } catch {
        // Missing or unreadable managed state means no GitHub identity.
      }
      if (token) {
        event.env.GITHUB_TOKEN = token;
        event.env.GH_TOKEN = token;
      }
    });
  },
};
`;
}

/** The plugins a container 2.x server is started with, by id. */
export function openCode2ContainerPlugins(): ReadonlyArray<{ id: string; source: string }> {
  return [
    {
      id: OPENCODE2_CREDENTIAL_PLUGIN_ID,
      source: buildOpenCode2CredentialPluginSource({ hardened: "refuse-tools" }),
    },
    { id: OPENCODE2_GITHUB_ENV_PLUGIN_ID, source: buildOpenCode2GitHubEnvironmentPluginSource() },
  ];
}

/** The container's copy of the user's global OpenCode configuration, which 1.x reads. */
export const OPENCODE_CONTAINER_USER_CONFIG_DIR = "/home/node/.config/opencode";

/** Mirrors the user's configuration into the 2.x config directory (`user-config.ts`). */
const USER_CONFIG_SCRIPT = buildOpenCode2ContainerUserConfigScript(
  OPENCODE_CONTAINER_USER_CONFIG_DIR,
  OPENCODE2_CONTAINER_CONFIG_DIR,
  quoteShell,
);

/**
 * Changes whenever a plugin source or the configuration mirror does, so a
 * server started with older ones is replaced.
 */
export const OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ plugins: openCode2ContainerPlugins(), userConfig: USER_CONFIG_SCRIPT }))
  .digest("hex");

/**
 * The detached start script. The password arrives as `OPENCODE_PASSWORD`
 * from the delivered secrets file, is un-exported at once and handed to the
 * server alone (`boundedLaunchWithPrivateEnv`); its log writer and wrapper
 * never inherit it.
 */
export function buildOpenCode2ContainerStartScript(): string {
  const plugins = openCode2ContainerPlugins();
  const serve = `${OPENCODE2_CONTAINER_CLI_PATH} serve --port ${OPENCODE2_SERVER_PORT} --hostname 0.0.0.0`;
  return `
    set -e
    export -n OPENCODE_PASSWORD
    cd ${OPENCODE2_CONTAINER_DIRECTORY}
    ${keepPreviousLogCommand(OPENCODE2_CONTAINER_LOG)}
    umask 077
    rm -rf ${OPENCODE2_CONTAINER_CONFIG_DIR}/plugins
    mkdir -p /tmp/orkestrator-ai ${plugins.map(({ id }) => `${OPENCODE2_CONTAINER_CONFIG_DIR}/plugins/${id}`).join(" ")}
${plugins
  .map(
    ({ id, source }) =>
      `    printf '%s' ${quoteShell(source)} > ${openCode2ContainerPluginPath(id)}`,
  )
  .join("\n")}
    ${USER_CONFIG_SCRIPT}
    printf '%s' ${quoteShell(OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT)} > ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE}
    source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
    orkestrator_source_runtime_env 2>/dev/null || true
    unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN OPENCODE_SERVER_PASSWORD OPENCODE_SERVER_USERNAME
    export OPENCODE_CONFIG_DIR=${OPENCODE2_CONTAINER_CONFIG_DIR}
    export OPENCODE_DISABLE_AUTOUPDATE=1
    export OPENCODE_FLAGS=${quoteShell(OPENCODE2_FLAGS)}
    ${persistentStateExports("opencode2")}
    ${boundedLaunchWithPrivateEnv(serve, OPENCODE2_CONTAINER_LOG, "OPENCODE_PASSWORD")}
  `;
}

/** The script that stops the container's 2.x server and forgets what it was started with. */
export const STOP_OPENCODE2_CONTAINER_SERVER_SCRIPT = `pkill -f '${OPENCODE2_CONTAINER_PROCESS_PATTERN}' || true; rm -f ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE}`;

/** Whether an image manifest's `agents` lists a 2.x `opencode2`. */
export function manifestRunsOpenCode2(
  agents: Readonly<Record<string, string>> | undefined,
): boolean {
  return /^2\.\d+\.\d+/.test(agents?.opencode2 ?? "");
}

/**
 * Whether `{{json .HostConfig.PortBindings}}` of a container (its network
 * owner's, behind an egress gateway) publishes the 2.x port. Static
 * configuration, so it answers for a stopped container too.
 */
export function publishesOpenCode2Port(portBindingsJson: string): boolean {
  try {
    const bindings = JSON.parse(portBindingsJson.trim() || "null") as unknown;
    return (
      typeof bindings === "object" &&
      bindings !== null &&
      Array.isArray((bindings as Record<string, unknown>)[`${OPENCODE2_SERVER_PORT}/tcp`])
    );
  } catch {
    return false;
  }
}
