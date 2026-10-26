import { isActiveBuildPhase, type BuildPhase } from "@orkestrator/protocol/build-pipeline";
import { realpathSync } from "node:fs";
import path from "node:path";
import { PINNED_TOOL_VERSIONS, type ToolchainName } from "@orkestrator/toolchain/manifest";
import type {
  HostImageStatus,
  HostRestartImpact,
  HostToolStatus,
} from "@orkestrator/protocol/host-maintenance";
import { resolveManagedBinary } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import { APP_VERSION } from "./constants.js";
import { configuredImageRef, getImageStatus, resolveDockerImage } from "./docker-image.js";
import { gitHubCli } from "./github-cli-binary.js";
import { runCommand } from "./shell.js";

/** The published image whose tag matches this backend (`publish-container.yml`). */
export const RELEASE_IMAGE_REPOSITORY = "ghcr.io/orkestrator-ai/orkestrator-v2";

export function releaseImageReference(version: string = APP_VERSION): string {
  return `${RELEASE_IMAGE_REPOSITORY}:${version}`;
}

/** What a restart of this backend would interrupt right now. */
export async function readRestartImpact(context: CommandContext): Promise<HostRestartImpact> {
  let workingAgents = 0;
  let waitingAgents = 0;
  if (!context.agentRegistry) throw new Error("Agent activity is unavailable");
  const registry = await context.agentRegistry.snapshot();
  let unknownAgents = 0;
  for (const entry of registry.entries) {
    if (entry.state === "working") workingAgents += 1;
    else if (entry.state === "waiting") waitingAgents += 1;
    else if (entry.state === "unknown") unknownAgents += 1;
  }
  const pipelines = await context.storage.listAllBuildPipelines();
  const activePipelines = pipelines.filter((pipeline) => {
    const phase = (pipeline.snapshot as { phase?: unknown }).phase;
    return isActiveBuildPhase(phase as BuildPhase);
  }).length;
  return {
    workingAgents,
    waitingAgents,
    unknownAgents,
    activePipelines,
    terminals: context.runtime.terminals.processCount(),
    containerTerminals: context.runtime.terminals.containerProcessCount(),
    hostServers: context.runtime.localServers.processCount(),
    measuredAt: new Date().toISOString(),
  };
}

/** `…/toolchains/<name>/<version>/…` → `<version>`. */
function managedVersion(executable: string, name: string): string | null {
  let resolved = executable;
  try {
    resolved = realpathSync(executable);
  } catch {
    return null;
  }
  const parts = resolved.split(path.sep);
  const root = parts.lastIndexOf("toolchains");
  const directory = parts[root + 1];
  const index =
    root >= 0 && (directory === name || (name === "gh" && directory === "gh-latest"))
      ? root + 1
      : -1;
  const version = index >= 0 ? parts[index + 1] : undefined;
  return version && /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

/**
 * Tools the backend also runs from PATH when no managed copy exists. Grok
 * never falls back (`resolveManagedAcpBinary`), so a `grok` on PATH is
 * reported missing: the backend would not use it.
 */
const PATH_FALLBACK_TOOLS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
  "gh",
]);

/** Each managed tool's pin, where this backend finds it, and the managed copy's version. */
export async function readToolStatus(
  context: CommandContext,
  ghChannel: "pinned" | "latest",
): Promise<HostToolStatus[]> {
  const tools: HostToolStatus[] = [];
  for (const [name, pinnedVersion] of Object.entries(PINNED_TOOL_VERSIONS) as Array<
    [ToolchainName, string]
  >) {
    const managed = name === "gh" ? (gitHubCli() === "gh" ? undefined : gitHubCli()) : undefined;
    const executable = managed ?? resolveManagedBinary(context, name);
    const status: HostToolStatus = executable
      ? {
          name,
          pinnedVersion,
          source: "managed",
          installedVersion: managedVersion(executable, name),
        }
      : {
          name,
          pinnedVersion,
          source: PATH_FALLBACK_TOOLS.has(name) && Bun.which(name) ? "path" : "missing",
          installedVersion: null,
        };
    if (name === "gh") status.channel = ghChannel;
    tools.push(status);
  }
  return tools;
}

/** Environments whose container was created from an image other than `imageId`. */
async function outdatedEnvironments(
  context: CommandContext,
  imageId: string,
): Promise<HostImageStatus["outdatedEnvironments"]> {
  const containers = (await context.storage.loadEnvironments()).filter(
    (environment) =>
      environment.environmentType === "containerized" &&
      environment.containerId &&
      !environment.deletionRequestedAt,
  );
  if (containers.length === 0) return [];
  let stdout = "";
  try {
    ({ stdout } = await runCommand(
      "docker",
      [
        "inspect",
        "--format",
        "{{.Id}} {{.Image}}",
        ...containers.map((environment) => environment.containerId!),
      ],
      { timeoutMs: 15_000 },
    ));
  } catch (error) {
    // A missing container fails the whole inspect but still prints the others.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const imageByContainer = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [containerId, image] = line.trim().split(" ");
    if (containerId && image) imageByContainer.set(containerId, image);
  }
  return containers
    .filter((environment) => {
      const id = environment.containerId!;
      const image = [...imageByContainer].find(([container]) => container.startsWith(id))?.[1];
      return image !== undefined && image !== imageId;
    })
    .map((environment) => ({
      id: environment.id,
      name: environment.name,
      projectId: environment.projectId,
    }))
    .slice(0, 200);
}

/** The environment image, whether it suits this backend, and who still runs an older one. */
export async function readImageStatus(context: CommandContext): Promise<HostImageStatus | null> {
  const status = await getImageStatus(context);
  if (status.state === "unavailable") return null;
  const present = status.state !== "missing";
  return {
    name: configuredImageRef(context),
    present,
    compatible: present ? status.state === "compatible" : null,
    reason: status.remediation,
    releaseReference: releaseImageReference(),
    outdatedEnvironments:
      present && status.imageId ? await outdatedEnvironments(context, status.imageId) : [],
  };
}

export { resolveDockerImage };
