import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  AGENT_PLATFORMS,
  isAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_LIMITS,
  McpManagementFailure,
  mcpFailure,
  mcpManagementErrorFromUnknown,
  normalizeMcpManagementRolloutSettings,
  type McpManagementRolloutSettings,
} from "@orkestrator/protocol/mcp-management";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { runCommandBuffer } from "./shell.js";
import type { ApplyEnvironment, ApplySession, RuntimeProbe } from "./mcp-management/apply.js";
import { DOCKER_LABEL_INPUTS_REVISION } from "./constants.js";
import { currentRuntimeIdentity } from "./container-lifecycle-service.js";
import { containerAllowedDomains, containerNetworkPolicy } from "./container-network.js";
import { observeContainerBoot } from "./container-readiness.js";
import { imageCapabilities } from "./docker-image.js";
import type { ContainerNetworkView } from "./mcp-management/network-hints.js";
import type { StagedDefaultsWriter } from "./mcp-management/overlay-service.js";
import type {
  ContainerBootReader,
  ContainerFileReader,
  ContainerFileWriter,
  ContainerPathProbe,
} from "./mcp-management/types.js";
import {
  McpManagementService,
  type McpManagementServiceOptions,
} from "./mcp-management/service.js";
import { containerLabel } from "./portable-input-status.js";
import { portableInputRevisionDirectory, replaceStagedInputFile } from "./portable-inputs.js";
import type { Environment } from "./models.js";

const PORT_FIELD: Record<AgentPlatform, keyof Environment> = {
  claude: "localClaudePort",
  codex: "localCodexPort",
  cursor: "localCursorPort",
  grok: "localGrokPort",
  opencode: "localOpencodePort",
  pi: "localPiPort",
};

const PID_FIELD: Record<AgentPlatform, keyof Environment> = {
  claude: "claudeBridgePid",
  codex: "codexBridgePid",
  cursor: "cursorBridgePid",
  grok: "grokBridgePid",
  opencode: "opencodePid",
  pi: "piBridgePid",
};

/**
 * Runtime facts the apply scheduler needs, read from existing backend state.
 * Reads are no-touch: persisted records and the activity sweep's last
 * observation, never a tab-facing bridge route.
 */
export function createMcpRuntimeProbe(context: CommandContext): RuntimeProbe {
  return {
    async environments(): Promise<ApplyEnvironment[]> {
      const environments = await context.storage.loadEnvironments();
      return environments
        .filter((environment) => !environment.deletionRequestedAt)
        .map((environment) => ({
          id: environment.id,
          name: environment.name,
          status: environment.status,
          environmentType: environment.environmentType,
          providerRunning: (provider) =>
            environment.environmentType === "containerized"
              ? environment.status === "running"
              : typeof environment[PORT_FIELD[provider]] === "number",
          bridgePid: (provider) => {
            const pid = environment[PID_FIELD[provider]];
            return environment.environmentType === "local" &&
              typeof pid === "number" &&
              Number.isSafeInteger(pid) &&
              pid > 0
              ? pid
              : undefined;
          },
        }));
    },
    async sessions(): Promise<ApplySession[]> {
      const sessions = await context.storage.listNativeAgentSessions();
      return sessions
        .filter((session) => isAgentPlatform(session.agent))
        .map((session) => ({
          environmentId: session.environmentId,
          agent: session.agent as AgentPlatform,
          logicalSessionKey: session.logicalSessionKey,
          providerSessionId: session.providerSessionId,
          pendingDispatch: !!session.pendingDispatch,
          coordinator: session.executionPolicy === "coordinator-read-only",
          projectResources: session.policy?.projectResources,
        }));
    },
    activity(environmentId, agent, logicalSessionKey) {
      const service = context.nativeAgents;
      if (!service) return "unknown";
      return service.sessionTurnActivitySnapshot(environmentId, agent as never, logicalSessionKey);
    },
    async reloadCodex(environmentId) {
      const service = context.nativeAgents;
      // No native agent service means no bridge is running in this backend.
      if (!service) return "not-running";
      // Environment-level and no-spawn: never resolves a session (which a
      // restarted bridge may not have) and never cold-starts app-server.
      return service.reloadMcpConfigurationIfRunning(environmentId, "codex");
    },
    async mcpConfigEvidence(environmentId, agent, logicalSessionKey) {
      const service = context.nativeAgents;
      if (!service) return { state: "not-running" };
      // Observation only: resolves an already-running bridge and reads the
      // no-touch runtime-health route, so it never starts a bridge, refreshes
      // a session's liveness or re-attaches an idle one.
      const read = await service.mcpConfigEvidenceIfRunning(
        environmentId,
        agent as never,
        logicalSessionKey,
      );
      return read.state === "evidence"
        ? {
            state: "evidence",
            evidence: {
              sources: read.evidence.sources,
              observedAt: read.evidence.observedAt,
              scope: read.evidence.scope,
              ...(read.evidence.staleServers ? { staleServers: read.evidence.staleServers } : {}),
            },
          }
        : read;
    },
  };
}

/**
 * Bounded, read-only file read inside a container as the `node` user. The path
 * is an argument to a fixed script, never interpolated into shell text, and
 * exit code 3 distinguishes a missing file from an unreachable container.
 */
export const readContainerMcpFile: ContainerFileReader = async (
  containerId,
  filePath,
  maxBytes,
) => {
  try {
    const { stdout } = await runCommandBuffer(
      "docker",
      [
        "exec",
        "--user",
        "node",
        containerId,
        "sh",
        "-c",
        'test -f "$1" || exit 3; head -c "$2" "$1"',
        "sh",
        filePath,
        String(maxBytes + 1),
      ],
      { timeoutMs: 10_000 },
    );
    return stdout.byteLength > maxBytes
      ? { state: "oversized" }
      : { state: "ok", bytes: new Uint8Array(stdout) };
  } catch (error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    return exitCode === 3 ? { state: "absent" } : { state: "offline" };
  }
};

/**
 * The fixed program behind {@link writeContainerMcpFile}. It is never built
 * from data: the destination, expected digest, mode and bound are argv, and
 * the payload is stdin. It refuses anything outside `/home/node` and
 * `/workspace`, any symlink on the way down, and a non-regular destination;
 * creates missing parents owner-only; compares the current bytes with the
 * expected digest (exit 3 on mismatch); and replaces the file atomically.
 */
const CONTAINER_WRITER_SCRIPT = `"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [file, expected, mode, maxText] = process.argv.slice(1);
const max = Number(maxText);
const exit = (code) => process.exit(code);
const roots = ["/home/node", "/workspace"];
if (!file || !path.isAbsolute(file) || path.normalize(file) !== file) exit(4);
const root = roots.find((candidate) => file.startsWith(candidate + "/"));
if (!root || !Number.isSafeInteger(max) || max <= 0) exit(4);
const parts = file.slice(root.length + 1).split("/");
if (parts.some((part) => !part || part === "." || part === "..")) exit(4);
let directory = root;
if (!fs.lstatSync(directory).isDirectory()) exit(4);
for (const part of parts.slice(0, -1)) {
  directory = path.join(directory, part);
  let info = null;
  try { info = fs.lstatSync(directory); } catch (error) { if (error.code !== "ENOENT") exit(4); }
  if (!info) { fs.mkdirSync(directory, { mode: 0o700 }); info = fs.lstatSync(directory); }
  if (!info.isDirectory()) exit(4);
}
let current = null;
let existingMode = null;
let fd = null;
try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (error) { if (error.code !== "ENOENT") exit(4); }
if (fd !== null) {
  const info = fs.fstatSync(fd);
  if (!info.isFile()) exit(4);
  existingMode = info.mode & 0o777;
  current = fs.readFileSync(fd);
  fs.closeSync(fd);
}
const digest = current === null ? "absent" : "sha256:" + crypto.createHash("sha256").update(current).digest("base64url");
if (digest !== expected) exit(3);
const chunks = [];
let size = 0;
for (;;) {
  const buffer = Buffer.alloc(65536);
  let read = 0;
  try { read = fs.readSync(0, buffer, 0, buffer.length, null); } catch (error) { if (error.code === "EAGAIN") continue; if (error.code === "EOF") break; throw error; }
  if (read === 0) break;
  size += read;
  if (size > max) exit(5);
  chunks.push(buffer.subarray(0, read));
}
const target = mode === "private" ? 0o600 : (existingMode === null ? 0o644 : existingMode);
const temporary = path.join(path.dirname(file), "." + path.basename(file) + ".ork-" + process.pid + ".tmp");
const out = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, target);
try { fs.writeSync(out, Buffer.concat(chunks)); fs.fchmodSync(out, target); fs.fsyncSync(out); } finally { fs.closeSync(out); }
try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
`;

/**
 * Narrow write of one MCP configuration file inside a container, as the
 * `node` user, through {@link CONTAINER_WRITER_SCRIPT}. Callers pass a path
 * from the backend's own source specs; the renderer never supplies a command
 * or a container path.
 */
export const writeContainerMcpFile: ContainerFileWriter = async (containerId, filePath, write) => {
  const max = MCP_MANAGEMENT_LIMITS.sourceFileMaxBytes;
  if (write.bytes.byteLength > max) return { state: "oversized" };
  try {
    await runCommandBuffer(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "node",
        containerId,
        "node",
        "-e",
        CONTAINER_WRITER_SCRIPT,
        filePath,
        write.expectedDigest,
        write.mode,
        String(max),
      ],
      { timeoutMs: 15_000, stdin: Buffer.from(write.bytes) },
    );
    return { state: "ok" };
  } catch (error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    if (exitCode === 3) return { state: "conflict" };
    if (exitCode === 4) return { state: "refused" };
    if (exitCode === 5) return { state: "oversized" };
    const message = error instanceof Error ? error.message : "";
    return /is not running|No such container|is paused/i.test(message)
      ? { state: "offline" }
      : { state: "failed" };
  }
};

/** The container's current boot id; `null` for an image without boot status. */
export const readContainerBootId: ContainerBootReader = async (containerId) => {
  const observation = await observeContainerBoot(containerId);
  return observation.kind === "current" ? observation.bootId : null;
};

/**
 * Which of `paths` exist inside a container, and as what, from one exec.
 * Paths are arguments to a fixed script; one answer line per path.
 */
export const probeContainerMcpPaths: ContainerPathProbe = async (containerId, paths) => {
  if (!paths.length) return new Map();
  try {
    const { stdout } = await runCommandBuffer(
      "docker",
      [
        "exec",
        "--user",
        "node",
        containerId,
        "sh",
        "-c",
        'for p in "$@"; do if [ -d "$p" ]; then echo d; elif [ -e "$p" ]; then echo f; else echo a; fi; done',
        "sh",
        ...paths,
      ],
      { timeoutMs: 10_000 },
    );
    const lines = stdout.toString("utf8").trim().split("\n");
    if (lines.length !== paths.length) return null;
    return new Map(
      paths.map((candidate, index) => [
        candidate,
        lines[index] === "d" ? "directory" : lines[index] === "f" ? "file" : "absent",
      ]),
    );
  } catch {
    return null;
  }
};

/**
 * Staged inputs each environment-private source is copied from at boot,
 * relative to the container's input revision. Claude's `.claude.json` is
 * absent on purpose: it is staged again from the backend user before every
 * container start, so a refresh needs no staged rewrite.
 */
function stagedInputPath(sourceId: string): string | null {
  switch (sourceId) {
    case "codex:user":
      return "codex-home/config.toml";
    case "grok:user":
      return "grok-home/config.toml";
    case "pi:user":
      return "pi-config/agent/mcp.json";
    case "cursor:user":
      return "cursor-config/mcp.json";
    default: {
      const name = /^opencode:user-((?:config|opencode)\.jsonc?)$/.exec(sourceId)?.[1];
      return name ? `opencode-config/${name}` : null;
    }
  }
}

/** Rewrites one staged input of a container's revision; never follows a link. */
export function createStagedDefaultsWriter(
  context: Pick<CommandContext, "storage">,
): StagedDefaultsWriter {
  return {
    async update(environmentId, containerId, sourceId, rewrite) {
      const relative = stagedInputPath(sourceId);
      if (!relative) return "unavailable";
      const revision = await containerLabel(containerId, DOCKER_LABEL_INPUTS_REVISION);
      if (!revision) return "unavailable";
      const dataDir = context.storage.getDataDir();
      const file = path.join(
        portableInputRevisionDirectory(dataDir, environmentId, revision),
        relative,
      );
      let text: string;
      try {
        const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          if ((await handle.stat()).size > MCP_MANAGEMENT_LIMITS.sourceFileMaxBytes)
            return "unavailable";
          text = (await handle.readFile()).toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        // Nothing was staged, so nothing is mounted to carry a new copy.
        return "unavailable";
      }
      const written = await replaceStagedInputFile(
        dataDir,
        environmentId,
        revision,
        relative,
        rewrite(text),
      );
      return written ? "updated" : "unavailable";
    },
  };
}

/** A container's allowlist as its firewall has it, for URL warnings. */
export function containerNetworkView(
  context: Pick<CommandContext, "storage">,
): (environmentId: string) => Promise<ContainerNetworkView | null> {
  return async (environmentId) => {
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment || environment.environmentType !== "containerized") return null;
    if (environment.networkAccessMode === "full") return { mode: "full" };
    const config = await context.storage.loadConfig();
    const imageId = currentRuntimeIdentity(environment, context)?.imageId;
    const policyVersion = containerNetworkPolicy(
      (await imageCapabilities(imageId, context))?.["network-policy"] ?? 0,
      process.env.ORKESTRATOR_NETWORK_POLICY,
    );
    return {
      mode: "restricted",
      allowedDomains: containerAllowedDomains(environment, config, policyVersion),
      policyVersion,
    };
  };
}

/** Container I/O and policy views the production service is built with. */
export function mcpContainerOptions(
  context: Pick<CommandContext, "storage">,
): Pick<
  McpManagementServiceOptions,
  | "readContainerFile"
  | "writeContainerFile"
  | "readContainerBootId"
  | "stagedDefaults"
  | "containerNetwork"
  | "probeContainerPaths"
> {
  return {
    readContainerFile: readContainerMcpFile,
    writeContainerFile: writeContainerMcpFile,
    readContainerBootId: readContainerBootId,
    stagedDefaults: createStagedDefaultsWriter(context),
    containerNetwork: containerNetworkView(context),
    probeContainerPaths: probeContainerMcpPaths,
  };
}

const services = new WeakMap<object, McpManagementService>();

/** The context's service, or one created for this storage (tests, alternate hosts). */
export function mcpManagement(context: CommandContext): McpManagementService {
  if (context.mcpManagement) return context.mcpManagement;
  let service = services.get(context.storage);
  if (!service) {
    service = new McpManagementService({
      dataDir: context.storage.getDataDir(),
      storage: context.storage,
      emit: (event, payload) => context.emit(event, payload),
      probe: createMcpRuntimeProbe(context),
      ...mcpContainerOptions(context),
      loadRollout: mcpRolloutLoader(context),
    });
    services.set(context.storage, service);
  }
  return service;
}

/** Reads the stored rollout gate from the global config. */
export function mcpRolloutLoader(context: Pick<CommandContext, "storage">): () => Promise<unknown> {
  return async () => (await context.storage.loadConfig()).global.mcpManagement;
}

function newCorrelationId(): string {
  return `mcpe-${randomBytes(9).toString("base64url")}`;
}

/**
 * Give every structured failure a correlation id and log it with the code
 * only — never a value, path or provider text — so an operator can match the
 * reference a user reports to exactly one log line.
 */
export async function withMcpCorrelation<T>(command: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const known = mcpManagementErrorFromUnknown(error);
    const detail = known ?? mcpFailure("internal").detail;
    const correlationId = detail.correlationId ?? newCorrelationId();
    console.warn(
      `[mcp-management] ${command} failed: code=${detail.code} ref=${correlationId}${
        known ? "" : ` cause=${error instanceof Error ? error.name : typeof error}`
      }`,
    );
    throw new McpManagementFailure({ ...detail, correlationId });
  }
}

function parseProviders(value: unknown, field: string): AgentPlatform[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !isAgentPlatform(entry)))
    throw mcpFailure("invalid-request", { message: `${field} must list known providers.` });
  return AGENT_PLATFORMS.filter((provider) => value.includes(provider));
}

/**
 * MCP configuration management. Administrative UI commands only: they are not
 * exposed as Control MCP tools, and none of them accepts a filesystem path.
 */
export function registerMcpManagementCommands(register: CommandRegistrar): void {
  const route = (
    name: string,
    run: (args: Record<string, unknown>, context: CommandContext) => Promise<unknown>,
  ) => register(name, (args, context) => withMcpCorrelation(name, () => run(args, context)));
  route("list_mcp_management_targets", (args, context) => mcpManagement(context).listTargets(args));
  route("get_mcp_management_snapshot", (args, context) => mcpManagement(context).snapshot(args));
  route("get_mcp_definition", (args, context) => mcpManagement(context).getDefinition(args));
  route("validate_mcp_mutation", (args, context) => mcpManagement(context).validate(args));
  route("mutate_mcp_definition", (args, context) => mcpManagement(context).mutate(args));
  route("apply_mcp_configuration", (args, context) => mcpManagement(context).apply(args));
  route("get_mcp_operation", (args, context) => mcpManagement(context).getOperation(args));
  route("cancel_mcp_apply", (args, context) => mcpManagement(context).cancelApply(args));
  // Environment overlays: a container's own MCP changes and its inherited defaults.
  route("resolve_mcp_environment_overlay", (args, context) =>
    mcpManagement(context).resolveOverlay(args),
  );
  route("preview_mcp_environment_defaults", (args, context) =>
    mcpManagement(context).previewDefaultsRefresh(args),
  );
  route("refresh_mcp_environment_defaults", (args, context) =>
    mcpManagement(context).refreshDefaults(args),
  );

  // Backend-owned rollout gate / kill switch (`global.mcpManagement`). An
  // operator surface, not a user preference; see McpManagementRolloutSettings.
  route("get_mcp_management_rollout", async (_args, context) =>
    normalizeMcpManagementRolloutSettings(
      (await context.storage.loadConfig()).global.mcpManagement,
    ),
  );
  route("set_mcp_management_rollout", async (args, context) => {
    if (args.enabled !== undefined && typeof args.enabled !== "boolean")
      throw mcpFailure("invalid-request", { message: "enabled must be a boolean." });
    const writeProviders = parseProviders(args.writeProviders, "writeProviders");
    const applyProviders = parseProviders(args.applyProviders, "applyProviders");
    const current = await context.storage.loadConfig();
    const existing = normalizeMcpManagementRolloutSettings(current.global.mcpManagement);
    const next: McpManagementRolloutSettings = {
      enabled: (args.enabled as boolean | undefined) ?? existing.enabled,
      writeProviders: writeProviders ?? existing.writeProviders,
      applyProviders: applyProviders ?? existing.applyProviders,
    };
    await context.storage.updateMcpManagementRollout(next);
    return mcpManagement(context).refreshRollout();
  });
}
