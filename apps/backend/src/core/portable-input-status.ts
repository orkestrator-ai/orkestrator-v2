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
import { pruneInputRevisions, readInputsManifest } from "./portable-inputs.js";
import { CONTAINER_CURSOR_API_KEY_FILE } from "./commands-runtime-state.js";
import { CONTAINER_CURSOR_SDK_AUTH_FILE } from "./cursor-sdk-bridge.js";
import { dockerExec } from "./commands-container-exec.js";

/**
 * Which providers' portable inputs a new container receives: the enabled
 * platforms, narrowed further in agent-test profiles to the providers whose
 * credentials the profile explicitly authorized. Git identity is always
 * staged outside agent-test profiles.
 */
export function selectedInputProviders(
  context: Pick<CommandContext, "runtimeFlavor" | "credentialSources">,
  enabledAgentPlatforms: unknown,
): Set<AgentPlatform | "git"> {
  const enabled = normalizeAgentPlatforms(enabledAgentPlatforms);
  const selected = new Set<AgentPlatform | "git">();
  for (const platform of enabled) {
    if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has(platform)) {
      continue;
    }
    selected.add(platform);
  }
  if (context.runtimeFlavor !== "agent-test") selected.add("git");
  return selected;
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
  };
  if (environment.environmentType !== "containerized" || !environment.containerId) return base;
  const config = await context.storage.loadConfig();
  const selected = selectedInputProviders(context, config.global.enabledAgentPlatforms);
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
      (provider) => provider !== "git" && !selected.has(provider),
    ),
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
   * The runtime still exposes the provider's inputs through an immutable
   * mount (whole-home mounts or a staged revision): a rebuild completes the
   * revocation. Processes already running may also hold the credential.
   */
  pendingRebuild: boolean;
}

/**
 * Removes one provider's imported credentials from an environment's running
 * container. It never touches the host's own credentials or revokes an
 * account-wide key: rotating that is the user's action with the provider.
 */
export async function revokeProviderCredentials(
  environmentId: string,
  provider: AgentPlatform,
  context: Pick<CommandContext, "storage" | "runtimeFlavor" | "credentialSources">,
): Promise<RevocationResult> {
  if (!AGENT_PLATFORMS.includes(provider)) throw new Error("Unknown provider");
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment?.containerId) throw new Error(`Environment has no container: ${environmentId}`);
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
  const status = await environmentInputStatus(environmentId, context);
  const pendingRebuild =
    status.mode === "host-mounts" ||
    status.mode === "unknown" ||
    status.providers.some((entry) => entry.provider === provider);
  return { provider, removed, pendingRebuild };
}
