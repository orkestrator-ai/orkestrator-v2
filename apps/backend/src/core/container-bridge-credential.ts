import { randomBytes } from "node:crypto";
import {
  bridgeAuthorityKeyEnv,
  isBridgeAuthorityKey,
  mintBridgeAuthorityKeyPair,
} from "@orkestrator/protocol/node/bridge-authority";
import {
  bridgeTokenVerifier,
  bridgeTokenVerifierEnv,
  mintBridgeToken,
} from "@orkestrator/protocol/node/bridge-credential";
import { forgetBridgeAuthorityKey, rememberBridgeAuthorityKey } from "./bridge-authority-keys.js";
import { quoteShell } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import { dockerExecDetached } from "./commands-server-health.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { boundedBackgroundLaunch } from "./container-log-bounds.js";
import {
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  CURSOR_BRIDGE_PORT,
  GROK_ACP_BRIDGE_PORT,
  OPENCODE_SERVER_PORT,
  PI_BRIDGE_PORT,
} from "./constants.js";
import { CONTAINER_ROOT_USER_ARGS } from "./container-scripts.js";
import { BRIDGE_TOKEN_PATTERN, type LocalServerKind } from "./local-server-runtime.js";
import {
  judgeOpenCodeListener,
  listOpenCodeListenersScript,
  OPENCODE_LISTENER_RECORD,
  parseOpenCodeListeners,
  type OpenCodeListenerJudgement,
} from "./opencode-listener-identity.js";
import { createLogger } from "@orkestrator/protocol/logger";
import { runCommand } from "./shell.js";

const log = createLogger("docker");

/**
 * Where a container bridge's control token lives and how it gets there.
 *
 * On an image with `bridge-credential=1` the token sits in a root-only file the
 * backend reads with a root exec, and the bridge is given only its SHA-256, so
 * nothing running as `node` holds the token. OpenCode compares a plain password,
 * so it takes the password itself and a plugin keeps it from its tools
 * (`buildOpenCodeCredentialPluginSource`). On an older image, and for a bridge an
 * older backend started, the token stays in `/tmp` and in the bridge's
 * environment, where the agent can read it, until the container is rebuilt.
 * Either way it reaches the container on stdin, never in `docker exec` argv,
 * where any local user can read it through `ps` or `/proc`.
 *
 * On an image with `bridge-launch=1` (`launcher` mode) the root-only directory
 * also holds the private half of an authority key, whose public half the bridge
 * requires a signature from on everything that changes an agent's authority
 * (`bridge-authority-keys.ts`). Such a bridge is started by the root-owned
 * `orkestrator-bridge-launch`, from the backend's own exec, so the public key
 * and the verifier never pass through the `node` login shell that prepares the
 * start: that shell only records the environment it built, for the bridge to
 * hand to its agents.
 */
export type ContainerBridgeKind = Exclude<LocalServerKind, "opencode">;
/**
 * Whose credential a root file holds: a bridge, OpenCode 1.x, or the OpenCode
 * 2.x server (`opencode2-container-server.ts`), which has no `node`-readable
 * token file because only images with root credential files carry it.
 */
export type ContainerCredentialKind = LocalServerKind | "opencode2";
export type ContainerCredentialMode = "launcher" | "verifier" | "token-file";

export const CONTAINER_BRIDGE_LAUNCHER = "/usr/local/bin/orkestrator-bridge-launch";

export const CONTAINER_BRIDGE_CREDENTIAL_DIR = "/run/orkestrator-bridge";

/** The `node`-readable token file of an older image or an older backend's bridge. */
export const CONTAINER_TOKEN_FILES: Record<LocalServerKind, string> = {
  claude: "/tmp/claude-bridge-token",
  codex: "/tmp/codex-bridge-token",
  cursor: "/tmp/cursor-bridge-token",
  grok: "/tmp/grok-acp-bridge-token",
  pi: "/tmp/pi-bridge-token",
  opencode: "/tmp/opencode-server-password",
};

const TOKEN_ENV: Record<ContainerBridgeKind, string> = {
  claude: "CLAUDE_BRIDGE_TOKEN",
  codex: "CODEX_BRIDGE_TOKEN",
  cursor: "CURSOR_BRIDGE_TOKEN",
  grok: "ACP_BRIDGE_TOKEN",
  pi: "PI_BRIDGE_TOKEN",
};

/**
 * `bun` for an image that keeps the token from `node`. Bun reads `bunfig.toml`,
 * `preload` included, from its working directory: a checkout, whose code would
 * otherwise run inside the bridge and see each token presented to it.
 */
const VERIFIER_BUN = "bun --config=/dev/null";

export function containerCredentialFile(kind: ContainerCredentialKind): string {
  return `${CONTAINER_BRIDGE_CREDENTIAL_DIR}/${kind}-token`;
}

/** The private half of a launcher-mode bridge's authority key, beside its token. */
export function containerAuthorityKeyFile(kind: ContainerCredentialKind): string {
  return `${CONTAINER_BRIDGE_CREDENTIAL_DIR}/${kind}-authority`;
}

/** What a start script needs to hand a fresh token to the bridge it launches. */
export interface ContainerBridgeLaunch {
  token: string;
  /** Goes through {@link launchContainerScript}, after the start has committed to launching. */
  launch: ContainerScriptLaunch;
  /** Script lines exporting what the bridge authenticates with; run under `umask 077`. */
  script: string;
  /** The command that runs the bridge's entrypoint. */
  bun: string;
  /**
   * The script's last line: start `entry` (the bridge's file and arguments)
   * with output to `logFile`, or, in `launcher` mode, record the environment
   * the script built for the launcher to start the bridge with.
   */
  start(entry: string, logFile: string): string;
}

/**
 * A bridge, or on an `opencode-launch=1` image the OpenCode server, that
 * {@link launchContainerScript} starts through `orkestrator-bridge-launch`.
 */
export interface ContainerBridgeLauncherStart {
  kind: ContainerBridgeKind | "opencode";
  /** Where the start script records its environment; the bridge removes it. */
  snapshot: string;
  /** The backend's own values, passed to the launcher on stdin. */
  env: Record<string, string>;
}

export interface ContainerScriptLaunch {
  /** The file and token to write as root, before the script runs. */
  rootCredential?: { kind: ContainerCredentialKind; token: string; authorityKey?: string };
  removeRootCredential?: ContainerCredentialKind;
  /** Exported at the top of the script, delivered on stdin. */
  secrets?: Record<string, string | undefined>;
  /**
   * Run the script to completion as preparation, then start the bridge with
   * the launcher. Without it the script is detached and starts the bridge itself.
   */
  launcher?: ContainerBridgeLauncherStart;
}

/** What only the launcher may give a bridge: the verifier, the authority key and the port. */
function launcherEnvironment(
  kind: ContainerBridgeKind,
  token: string,
  publicKey: string,
  port: number,
): Record<string, string> {
  const tokenEnv = TOKEN_ENV[kind];
  return {
    [bridgeTokenVerifierEnv(tokenEnv)]: bridgeTokenVerifier(token),
    [bridgeAuthorityKeyEnv(tokenEnv)]: publicKey,
    PORT: String(port),
    HOSTNAME: "0.0.0.0",
  };
}

/** Each bridge's port inside the container, which only the launcher sets in `launcher` mode. */
const CONTAINER_BRIDGE_PORTS: Record<ContainerBridgeKind, number> = {
  claude: CLAUDE_BRIDGE_PORT,
  codex: CODEX_BRIDGE_PORT,
  cursor: CURSOR_BRIDGE_PORT,
  grok: GROK_ACP_BRIDGE_PORT,
  pi: PI_BRIDGE_PORT,
};

export function containerBridgeLaunch(
  kind: ContainerBridgeKind,
  mode: ContainerCredentialMode,
  token = mintBridgeToken(),
): ContainerBridgeLaunch {
  const tokenEnv = TOKEN_ENV[kind];
  const detached = (bun: string) => (entry: string, logFile: string) =>
    boundedBackgroundLaunch(`${bun} ${entry}`, logFile);
  if (mode === "launcher") {
    const keys = mintBridgeAuthorityKeyPair();
    const snapshot = `/tmp/.orkestrator-bridge-env-${kind}-${randomBytes(16).toString("hex")}`;
    return {
      token,
      launch: {
        rootCredential: { kind, token, authorityKey: keys.privateKey },
        launcher: {
          kind,
          snapshot,
          env: launcherEnvironment(kind, token, keys.publicKey, CONTAINER_BRIDGE_PORTS[kind]),
        },
      },
      // Nothing about the credential goes through this shell.
      script: `rm -f ${CONTAINER_TOKEN_FILES[kind]}`,
      bun: VERIFIER_BUN,
      start: () => `env -0 > ${snapshot}`,
    };
  }
  if (mode === "verifier") {
    return {
      token,
      launch: { rootCredential: { kind, token } },
      // A token an older backend left behind says nothing about this bridge.
      script: `rm -f ${CONTAINER_TOKEN_FILES[kind]}
      export ${bridgeTokenVerifierEnv(tokenEnv)}=${bridgeTokenVerifier(token)}`,
      bun: VERIFIER_BUN,
      start: detached(VERIFIER_BUN),
    };
  }
  return {
    token,
    launch: { secrets: { [tokenEnv]: token }, removeRootCredential: kind },
    script: `printf '%s' "$${tokenEnv}" > ${CONTAINER_TOKEN_FILES[kind]}`,
    bun: "bun",
    start: detached("bun"),
  };
}

/**
 * Write `token`, and the authority key when there is one, where only root in
 * the container can read them. A start without a key removes any earlier one,
 * so a key never outlives the token it was minted with.
 */
export async function writeContainerBridgeCredential(
  containerId: string,
  kind: ContainerCredentialKind,
  token: string,
  authorityKey?: string,
): Promise<void> {
  const command = [
    "set -eu",
    "umask 077",
    `install -d -m 700 ${CONTAINER_BRIDGE_CREDENTIAL_DIR}`,
    "IFS= read -r token || true",
    "IFS= read -r key || true",
    `credential_tmp="$(mktemp ${CONTAINER_BRIDGE_CREDENTIAL_DIR}/.token.XXXXXX)"`,
    `key_tmp="$(mktemp ${CONTAINER_BRIDGE_CREDENTIAL_DIR}/.authority.XXXXXX)"`,
    'trap \'rm -f "$credential_tmp" "$key_tmp"\' EXIT',
    `rm -f ${containerAuthorityKeyFile(kind)}`,
    'printf \'%s\' "$token" > "$credential_tmp"',
    `if [ -n "$key" ]; then printf '%s' "$key" > "$key_tmp"; mv "$key_tmp" ${containerAuthorityKeyFile(kind)}; fi`,
    `mv "$credential_tmp" ${containerCredentialFile(kind)}`,
    "trap - EXIT",
    'rm -f "$key_tmp"',
  ].join("\n");
  await runCommand(
    "docker",
    ["exec", "-i", ...CONTAINER_ROOT_USER_ARGS, containerId, "sh", "-c", command],
    {
      stdin: `${token}\n${authorityKey ?? ""}\n`,
      timeoutMs: 30_000,
      redactValues: [token, authorityKey],
    },
  );
  if (authorityKey) rememberBridgeAuthorityKey(token, authorityKey);
}

export async function removeContainerBridgeCredential(
  containerId: string,
  kind: ContainerCredentialKind,
): Promise<void> {
  await runCommand(
    "docker",
    [
      "exec",
      ...CONTAINER_ROOT_USER_ARGS,
      containerId,
      "rm",
      "-f",
      containerCredentialFile(kind),
      containerAuthorityKeyFile(kind),
      // The listener record says which process the password belongs to.
      ...(kind === "opencode" ? [OPENCODE_LISTENER_RECORD] : []),
    ],
    { timeoutMs: 30_000 },
  );
}

/** OpenCode's password in root's file, and whether the port's listener is the server it was given to. */
export interface ContainerOpenCodeCredential {
  token: string | null;
  listener: OpenCodeListenerJudgement;
}

/**
 * Root's OpenCode password and, in the same root exec, a judgement of the
 * sockets listening on OpenCode's port against the one the backend recorded
 * when it launched the server (`opencode-listener-identity.ts`). Only a server
 * started on an `opencode-launch=1` image has a record; for anything else the
 * listener is `unrecorded` and the listing is skipped.
 */
export async function readContainerOpenCodeCredential(
  containerId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ContainerOpenCodeCredential> {
  const script = [
    `cat ${containerCredentialFile("opencode")} 2>/dev/null || true; echo`,
    `cat ${containerAuthorityKeyFile("opencode")} 2>/dev/null || true; echo`,
    `if [ -s ${OPENCODE_LISTENER_RECORD} ]; then`,
    `printf 'record %s\n' "$(cat ${OPENCODE_LISTENER_RECORD})"`,
    listOpenCodeListenersScript(OPENCODE_SERVER_PORT),
    "fi",
  ].join("\n");
  const { stdout } = await runCommand(
    "docker",
    ["exec", ...CONTAINER_ROOT_USER_ARGS, containerId, "sh", "-c", script],
    { timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal },
  );
  const [token = "", , ...rest] = stdout.split("\n");
  const listener = judgeOpenCodeListener(parseOpenCodeListeners(rest.join("\n")));
  return { token: BRIDGE_TOKEN_PATTERN.test(token.trim()) ? token.trim() : null, listener };
}

/** The token and, on a second line, the authority key, in one root exec. */
async function readRootCredential(
  containerId: string,
  kind: ContainerCredentialKind,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ token: string; authorityKey: string }> {
  const { stdout } = await runCommand(
    "docker",
    [
      "exec",
      ...CONTAINER_ROOT_USER_ARGS,
      containerId,
      "sh",
      "-c",
      `cat ${containerCredentialFile(kind)} 2>/dev/null || true; echo; cat ${containerAuthorityKeyFile(kind)} 2>/dev/null || true`,
    ],
    { timeoutMs, signal },
  );
  const [token = "", authorityKey = ""] = stdout.split("\n", 2);
  return { token: token.trim(), authorityKey: authorityKey.trim() };
}

/**
 * The token of the bridge running in this container, or null when it has none.
 *
 * The root file comes first, and root never reads the `/tmp` file: `node` can
 * make that a symlink to any file in the container.
 */
export async function readContainerBridgeToken(
  containerId: string,
  kind: ContainerCredentialKind,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (kind === "opencode") {
    const opencode = await readContainerOpenCodeCredential(containerId, options);
    if (opencode.token) {
      // The password would go to whatever answers the port now.
      if (opencode.listener === "replaced") {
        log.warn("opencode.listener-replaced", {});
        return null;
      }
      return opencode.token;
    }
  }
  const root =
    kind === "opencode"
      ? { token: "", authorityKey: "" }
      : await readRootCredential(containerId, kind, timeoutMs, options.signal);
  if (BRIDGE_TOKEN_PATTERN.test(root.token)) {
    // Signed requests to this bridge use the key that was minted with it.
    if (isBridgeAuthorityKey(root.authorityKey)) {
      rememberBridgeAuthorityKey(root.token, root.authorityKey);
    } else {
      forgetBridgeAuthorityKey(root.token);
    }
    return root.token;
  }
  if (kind === "opencode2") return null;
  const token = (
    await dockerExec(
      containerId,
      `cat ${CONTAINER_TOKEN_FILES[kind]} 2>/dev/null || true`,
      timeoutMs,
      undefined,
      options.signal,
    )
  ).trim();
  if (!BRIDGE_TOKEN_PATTERN.test(token)) return null;
  compatibilityPathUsage.record("bridge-credential.token-file");
  return token;
}

/**
 * Deliver `secrets` on stdin to a mode 600 file, and return the lines that
 * export them and remove it. `docker exec -d` has no stdin of its own, so this
 * is a separate exec, and the script is what deletes the file.
 */
async function deliverStartSecrets(
  containerId: string,
  secrets: Record<string, string>,
): Promise<{ file: string; source: string }> {
  const file = `/tmp/.orkestrator-start-${randomBytes(16).toString("hex")}`;
  const body = Object.entries(secrets)
    .map(([name, value]) => `export ${name}=${quoteShell(value)}\n`)
    .join("");
  await runCommand("docker", ["exec", "-i", containerId, "sh", "-c", `umask 077; cat > ${file}`], {
    stdin: body,
    timeoutMs: 30_000,
    redactValues: Object.values(secrets),
  });
  return { file, source: `. ${file}\nrm -f ${file}\n` };
}

/** Run a detached start script, with its secrets off the command line. */
export async function launchContainerScript(
  containerId: string,
  script: string,
  launch: ContainerScriptLaunch = {},
): Promise<void> {
  const secrets = Object.fromEntries(
    Object.entries(launch.secrets ?? {}).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
  const redactValues = [
    ...Object.values(secrets),
    launch.rootCredential?.token,
    launch.rootCredential?.authorityKey,
  ];
  if (launch.removeRootCredential) {
    await removeContainerBridgeCredential(containerId, launch.removeRootCredential);
  }
  if (launch.rootCredential) {
    await writeContainerBridgeCredential(
      containerId,
      launch.rootCredential.kind,
      launch.rootCredential.token,
      launch.rootCredential.authorityKey,
    );
  }
  const delivered = Object.keys(secrets).length
    ? await deliverStartSecrets(containerId, secrets)
    : undefined;
  try {
    if (launch.launcher) {
      // Preparation only, so it runs to completion: the launcher needs the
      // environment it records, and its failures are this start's.
      await dockerExec(
        containerId,
        `${delivered?.source ?? ""}${script}`,
        CONTAINER_PREPARE_TIMEOUT_MS,
        redactValues,
      );
      await startContainerBridgeWithLauncher(containerId, launch.launcher);
    } else {
      await dockerExecDetached(containerId, `${delivered?.source ?? ""}${script}`, redactValues);
    }
  } catch (error) {
    if (delivered) await dockerExec(containerId, `rm -f ${delivered.file}`).catch(() => undefined);
    if (launch.launcher) {
      await dockerExec(containerId, `rm -f ${launch.launcher.snapshot}`).catch(() => undefined);
    }
    throw error;
  }
}

const CONTAINER_PREPARE_TIMEOUT_MS = 60_000;

/** The launcher's stdin: the backend's values, one `NAME=VALUE` per line. */
export function containerBridgeLauncherInput(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\n\r\0]/.test(value)) {
        throw new Error("A bridge launch variable cannot be passed to the launcher");
      }
      return `${name}=${value}\n`;
    })
    .join("");
}

/**
 * Start a prepared bridge through the image's root-owned launcher, as `node`,
 * with no login shell: a fixed PATH and working directory, and the backend's
 * values on stdin rather than in argv.
 */
async function startContainerBridgeWithLauncher(
  containerId: string,
  launcher: ContainerBridgeLauncherStart,
): Promise<void> {
  await runCommand(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "node",
      "--workdir",
      "/",
      "--env",
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      containerId,
      CONTAINER_BRIDGE_LAUNCHER,
      launcher.kind,
      launcher.snapshot,
    ],
    {
      stdin: containerBridgeLauncherInput(launcher.env),
      timeoutMs: 30_000,
      // OpenCode's launch carries its password.
      redactValues: Object.values(launcher.env),
    },
  );
}
