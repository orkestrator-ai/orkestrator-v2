import {
  AGENT_PLATFORMS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_INPUTS_REVISION,
  DOCKER_LABEL_OWNER,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import type { EnvironmentInputStatus } from "@orkestrator/protocol/container-recovery";
import { pruneInputRevisions, readInputsManifest, scrubStagedProvider } from "./portable-inputs.js";
import { CONTAINER_CURSOR_API_KEY_FILE } from "./commands-runtime-state.js";
import { CONTAINER_CURSOR_SDK_AUTH_FILE } from "./cursor-sdk-bridge.js";
import { dockerExec } from "./commands-container-exec.js";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";

/**
 * Which providers' portable inputs a new container receives: the enabled
 * platforms, narrowed further in agent-test profiles to the providers whose
 * credentials the profile explicitly authorized, and never a provider the
 * user revoked for this environment. Git identity is always staged outside
 * agent-test profiles.
 */
export function selectedInputProviders(
  context: Pick<CommandContext, "runtimeFlavor" | "credentialSources">,
  enabledAgentPlatforms: unknown,
  revoked: readonly string[] = [],
): Set<AgentPlatform | "git"> {
  const enabled = normalizeAgentPlatforms(enabledAgentPlatforms);
  const selected = new Set<AgentPlatform | "git">();
  for (const platform of enabled) {
    if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has(platform)) {
      continue;
    }
    if (revoked.includes(platform)) continue;
    selected.add(platform);
  }
  if (context.runtimeFlavor !== "agent-test") selected.add("git");
  return selected;
}

/**
 * Whether a provider's credential may be handed to this environment's
 * container (created, staged or synced): enabled, authorized for agent-test
 * profiles, and not revoked for the environment.
 */
export function providerCredentialsAllowed(
  context: Pick<CommandContext, "runtimeFlavor" | "credentialSources">,
  enabledAgentPlatforms: unknown,
  environment: { revokedInputProviders?: readonly string[] } | null | undefined,
  provider: AgentPlatform,
): boolean {
  return selectedInputProviders(
    context,
    enabledAgentPlatforms,
    environment?.revokedInputProviders ?? [],
  ).has(provider);
}

async function containerLabel(containerId: string, label: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, containerId],
      { timeoutMs: 10_000 },
    );
    const value = stdout.trim();
    return value && value !== "<no value>" ? value : null;
  } catch {
    return null;
  }
}

async function hasImmutableProviderSecret(
  containerId: string,
  provider: AgentPlatform,
): Promise<boolean> {
  if (provider !== "claude" && provider !== "cursor") return false;
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{json .Config.Env}}", containerId],
      { timeoutMs: 10_000 },
    );
    const values = JSON.parse(stdout) as unknown;
    const prefix = provider === "claude" ? "ANTHROPIC_API_KEY=" : "CURSOR_API_KEY=";
    return (
      Array.isArray(values) &&
      values.some((value) => typeof value === "string" && value.startsWith(prefix))
    );
  } catch {
    return true;
  }
}

/**
 * Removes staged revisions no container of the environment binds anymore.
 * The referenced set comes from Docker labels of every container labelled
 * for the environment (recovery copies included); when Docker cannot be
 * asked, nothing is pruned.
 */
export async function pruneEnvironmentInputRevisions(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
): Promise<number> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=${DOCKER_LABEL_ENVIRONMENT_ID}=${environmentId}`,
        "--filter",
        `label=${DOCKER_LABEL_OWNER}=${owner}`,
        "--format",
        `{{.Label "${DOCKER_LABEL_INPUTS_REVISION}"}}`,
      ],
      { timeoutMs: 15_000 },
    ));
  } catch {
    return 0;
  }
  const referenced = new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return pruneInputRevisions(context.storage.getDataDir(), environmentId, referenced);
}

export async function environmentInputStatus(
  environmentId: string,
  context: Pick<CommandContext, "storage" | "runtimeFlavor" | "credentialSources">,
): Promise<EnvironmentInputStatus> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const base: EnvironmentInputStatus = {
    environmentId,
    mode: "none",
    revision: null,
    stagedAt: null,
    providers: [],
    missingProviders: [],
    disabledProviders: [],
    revokedProviders: [...(environment.revokedInputProviders ?? [])],
  };
  if (environment.environmentType !== "containerized" || !environment.containerId) return base;
  const config = await context.storage.loadConfig();
  const revoked = environment.revokedInputProviders ?? [];
  const selected = selectedInputProviders(context, config.global.enabledAgentPlatforms, revoked);
  const revision = await containerLabel(environment.containerId, DOCKER_LABEL_INPUTS_REVISION);
  if (!revision) return { ...base, mode: "host-mounts" };
  const manifest = await readInputsManifest(context.storage.getDataDir(), environmentId, revision);
  if (!manifest) return { ...base, mode: "unknown", revision };
  const staged = new Set(manifest.providers.map((entry) => entry.provider));
  return {
    environmentId,
    mode: "staged",
    revision,
    stagedAt: manifest.stagedAt,
    providers: manifest.providers,
    missingProviders: [...selected].filter((provider) => !staged.has(provider)),
    disabledProviders: [...staged].filter(
      (provider) => provider !== "git" && !selected.has(provider) && !revoked.includes(provider),
    ),
    revokedProviders: [...revoked],
  };
}

/** Imported credential files inside a container, per provider. */
export const IMPORTED_CREDENTIAL_FILES: Record<AgentPlatform, readonly string[]> = {
  claude: ["/home/node/.claude/.credentials.json"],
  codex: ["/home/node/.codex/auth.json"],
  opencode: ["/home/node/.local/share/opencode/auth.json"],
  grok: ["/home/node/.grok/auth.json"],
  pi: ["/home/node/.pi/agent/auth.json"],
  cursor: [CONTAINER_CURSOR_API_KEY_FILE, CONTAINER_CURSOR_SDK_AUTH_FILE],
};

export interface RevocationResult {
  provider: AgentPlatform;
  /** Imported credential files were removed from the running container. */
  removed: boolean;
  /**
   * The runtime still exposes the provider's inputs through a mount the
   * backend cannot empty (whole-home mounts of an older runtime, or an
   * unreadable record): a rebuild completes the revocation.
   */
  pendingRebuild: boolean;
  /** The provider's bridge process was stopped (it restarts without the credential). */
  processesStopped: boolean;
}

/** In-container processes the backend launched for a provider. */
const PROVIDER_PROCESS_PATTERNS: Record<AgentPlatform, string> = {
  claude: "[/]opt/claude-bridge/",
  codex: "[/]opt/codex-bridge/",
  cursor: "[/]opt/cursor-bridge/",
  pi: "[/]opt/pi-bridge/",
  grok: "[/]opt/acp-bridge/",
  opencode: "[o]pencode serve",
};

/**
 * Revokes one provider's credentials for an environment, durably: the
 * environment records the revocation (so no later staging or credential sync
 * hands them back), the provider's staged inputs are emptied (so a restart
 * imports nothing), the imported files are removed from the running
 * container and the provider's bridge is stopped. Terminals the user started
 * may still hold what they already read. It never touches the host's own
 * credentials or an account-wide key: rotating that is the user's action with
 * the provider.
 */
export async function revokeProviderCredentials(
  environmentId: string,
  provider: AgentPlatform,
  context: Pick<CommandContext, "storage" | "runtimeFlavor" | "credentialSources">,
): Promise<RevocationResult> {
  if (!AGENT_PLATFORMS.includes(provider)) throw new Error("Unknown provider");
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment?.containerId) throw new Error(`Environment has no container: ${environmentId}`);
  // Recorded first: whatever happens below, nothing hands the credential back.
  await context.storage.updateEnvironment(environmentId, {
    revokedInputProviders: [...new Set([...(environment.revokedInputProviders ?? []), provider])],
  });
  const revision = await containerLabel(environment.containerId, DOCKER_LABEL_INPUTS_REVISION);
  const scrubbed = revision
    ? await scrubStagedProvider(context.storage.getDataDir(), environmentId, revision, provider)
    : false;
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (parsed.supported) {
    for (const runtime of parsed.record.retainedRuntimes ?? []) {
      const retainedRevision = await containerLabel(
        runtime.containerId,
        DOCKER_LABEL_INPUTS_REVISION,
      );
      if (retainedRevision) {
        await scrubStagedProvider(
          context.storage.getDataDir(),
          environmentId,
          retainedRevision,
          provider,
        );
      }
    }
  }
  const immutableSecret = await hasImmutableProviderSecret(environment.containerId, provider);
  const files = IMPORTED_CREDENTIAL_FILES[provider];
  let removed = false;
  try {
    await dockerExec(
      environment.containerId,
      `rm -f ${files.map((file) => `'${file}'`).join(" ")}`,
    );
    removed = true;
  } catch {
    removed = false;
  }
  let processesStopped = false;
  try {
    await runCommand(
      "docker",
      [
        "exec",
        "--user",
        "root",
        environment.containerId,
        "sh",
        "-c",
        `pkill -TERM -f '${PROVIDER_PROCESS_PATTERNS[provider]}' || true`,
      ],
      { timeoutMs: 15_000 },
    );
    processesStopped = true;
  } catch {
    processesStopped = false;
  }
  return {
    provider,
    removed,
    pendingRebuild: !scrubbed || immutableSecret || !removed || !processesStopped,
    processesStopped,
  };
}

/**
 * Allows a revoked provider again. Its credential sync resumes at the next
 * start; its staged configuration returns with the next rebuild.
 */
export async function restoreProviderCredentials(
  environmentId: string,
  provider: AgentPlatform,
  context: Pick<CommandContext, "storage">,
): Promise<{ provider: AgentPlatform; pendingRebuild: boolean }> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  await context.storage.updateEnvironment(environmentId, {
    revokedInputProviders: (environment.revokedInputProviders ?? []).filter(
      (entry) => entry !== provider,
    ),
  });
  return { provider, pendingRebuild: true };
}
