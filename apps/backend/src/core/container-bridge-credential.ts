import { randomBytes } from "node:crypto";
import {
  bridgeTokenVerifier,
  bridgeTokenVerifierEnv,
  mintBridgeToken,
} from "@orkestrator/protocol/node/bridge-credential";
import { quoteShell } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import { dockerExecDetached } from "./commands-server-health.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { CONTAINER_ROOT_USER_ARGS } from "./container-scripts.js";
import { BRIDGE_TOKEN_PATTERN, type LocalServerKind } from "./local-server-runtime.js";
import { runCommand } from "./shell.js";

/**
 * Where a container bridge's control token lives and how it gets there.
 *
 * On an image with `bridge-credential=1` the token sits in a root-only file the
 * backend reads with a root exec, and the bridge is given only its SHA-256, so
 * nothing running as `node` holds the token. On an older image, and for a
 * bridge an older backend started, the token stays in `/tmp` and in the
 * bridge's environment, where the agent can read it, until the container is
 * rebuilt. Either way it reaches the container on stdin, never in `docker exec`
 * argv, where any local user can read it through `ps` or `/proc`.
 */
export type ContainerBridgeKind = Exclude<LocalServerKind, "opencode">;
export type ContainerCredentialMode = "verifier" | "token-file";

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

export function containerCredentialFile(kind: ContainerBridgeKind): string {
  return `${CONTAINER_BRIDGE_CREDENTIAL_DIR}/${kind}-token`;
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
}

export interface ContainerScriptLaunch {
  /** The file and token to write as root, before the script runs. */
  rootCredential?: { kind: ContainerBridgeKind; token: string };
  /** Exported at the top of the script, delivered on stdin. */
  secrets?: Record<string, string | undefined>;
}

export function containerBridgeLaunch(
  kind: ContainerBridgeKind,
  mode: ContainerCredentialMode,
  token = mintBridgeToken(),
): ContainerBridgeLaunch {
  const tokenEnv = TOKEN_ENV[kind];
  if (mode === "verifier") {
    return {
      token,
      launch: { rootCredential: { kind, token } },
      // A token an older backend left behind says nothing about this bridge.
      script: `rm -f ${CONTAINER_TOKEN_FILES[kind]}
      export ${bridgeTokenVerifierEnv(tokenEnv)}=${bridgeTokenVerifier(token)}`,
      bun: VERIFIER_BUN,
    };
  }
  return {
    token,
    launch: { secrets: { [tokenEnv]: token } },
    script: `printf '%s' "$${tokenEnv}" > ${CONTAINER_TOKEN_FILES[kind]}`,
    bun: "bun",
  };
}

/** Write `token` where only root in the container can read it. */
export async function writeContainerBridgeCredential(
  containerId: string,
  kind: ContainerBridgeKind,
  token: string,
): Promise<void> {
  const command = [
    "set -eu",
    "umask 077",
    `install -d -m 700 ${CONTAINER_BRIDGE_CREDENTIAL_DIR}`,
    `credential_tmp="$(mktemp ${CONTAINER_BRIDGE_CREDENTIAL_DIR}/.token.XXXXXX)"`,
    "trap 'rm -f \"$credential_tmp\"' EXIT",
    'cat > "$credential_tmp"',
    `mv "$credential_tmp" ${containerCredentialFile(kind)}`,
    "trap - EXIT",
  ].join("\n");
  await runCommand(
    "docker",
    ["exec", "-i", ...CONTAINER_ROOT_USER_ARGS, containerId, "sh", "-c", command],
    { stdin: token, timeoutMs: 30_000, redactValues: [token] },
  );
}

export async function removeContainerBridgeCredential(
  containerId: string,
  kind: ContainerBridgeKind,
): Promise<void> {
  await runCommand(
    "docker",
    ["exec", ...CONTAINER_ROOT_USER_ARGS, containerId, "rm", "-f", containerCredentialFile(kind)],
    { timeoutMs: 30_000 },
  );
}

async function readRootCredential(
  containerId: string,
  kind: ContainerBridgeKind,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await runCommand(
    "docker",
    [
      "exec",
      ...CONTAINER_ROOT_USER_ARGS,
      containerId,
      "sh",
      "-c",
      `cat ${containerCredentialFile(kind)} 2>/dev/null || true`,
    ],
    { timeoutMs, signal },
  );
  return stdout.trim();
}

/**
 * The token of the bridge running in this container, or null when it has none.
 *
 * The root file comes first, and root never reads the `/tmp` file: `node` can
 * make that a symlink to any file in the container.
 */
export async function readContainerBridgeToken(
  containerId: string,
  kind: LocalServerKind,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (kind !== "opencode") {
    const token = await readRootCredential(containerId, kind, timeoutMs, options.signal);
    if (BRIDGE_TOKEN_PATTERN.test(token)) return token;
  }
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
  if (kind !== "opencode") compatibilityPathUsage.record("bridge-credential.token-file");
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
  const redactValues = [...Object.values(secrets), launch.rootCredential?.token];
  if (launch.rootCredential) {
    await writeContainerBridgeCredential(
      containerId,
      launch.rootCredential.kind,
      launch.rootCredential.token,
    );
  }
  const delivered = Object.keys(secrets).length
    ? await deliverStartSecrets(containerId, secrets)
    : undefined;
  try {
    await dockerExecDetached(containerId, `${delivered?.source ?? ""}${script}`, redactValues);
  } catch (error) {
    if (delivered) await dockerExec(containerId, `rm -f ${delivered.file}`).catch(() => undefined);
    throw error;
  }
}
