/**
 * This backend's worktrees, added accounts and containers, as scoped
 * delivery reads them (`scoped-delivery.ts`, `container-staging.ts`), and
 * other machines' environments as the command node's read model knows them
 * (`scoped-remote.ts`). Nothing here writes: environments and accounts are
 * listed, and a container's record is read from its labels and its inputs
 * revision.
 */
import { DEFAULT_AGENT_ACCOUNT_ID } from "@orkestrator/protocol/agent-accounts";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";

import { agentAccountHome } from "../agent-accounts/homes.js";
import type { CommandContext } from "../commands/index.js";
import { DOCKER_LABEL_CAPABILITIES_DIGEST, DOCKER_LABEL_INPUTS_REVISION } from "../constants.js";
import { containerLabel } from "../portable-input-status.js";
import { readInputsManifest } from "../portable-inputs.js";
import { activeCapabilityEnvironment, busyHostProviders } from "./running-work.js";
import { readContainerCapabilityDelivery } from "./container-staging.js";
import type { ScopedAccount, ScopedEnvironment, ScopedTargetSources } from "./scoped-delivery.js";

/**
 * One machine's environments from node summaries (ids, project ids and
 * types; never a path), or null while its summaries have never been read.
 * Environments being deleted are left out.
 */
export function remoteScopedEnvironments(
  summaries: NodeSummariesResult,
  nodeId: string,
): ScopedEnvironment[] | null {
  const node = summaries.nodes.find((entry) => entry.nodeId === nodeId);
  if (!node || node.loadedAt === null) return null;
  return node.environments
    .filter((environment) => !environment.deleting && environment.environmentType !== undefined)
    .map((environment) => ({
      id: environment.ref.environmentId,
      name: environment.name,
      projectId: environment.projectId,
      environmentType: environment.environmentType!,
    }));
}

export function capabilityScopedSources(context: CommandContext): ScopedTargetSources {
  return {
    writeHeld: async ({ environmentId, account }) => {
      if (environmentId) {
        return activeCapabilityEnvironment(context, environmentId);
      }
      return account !== undefined && (await busyHostProviders(context)).includes(account.provider);
    },
    environments: async () =>
      (await context.storage.loadEnvironments()).map((environment) => ({
        id: environment.id,
        name: environment.name,
        projectId: environment.projectId,
        environmentType: environment.environmentType,
        worktreePath: environment.worktreePath ?? null,
        containerId: environment.containerId ?? null,
      })),
    accounts: async () => {
      const store = await context.storage.agentAccounts.loadAgentAccounts();
      const root = context.storage.agentAccounts.agentAccountsDirectory();
      return store.accounts.flatMap((account): ScopedAccount[] =>
        // The stored accounts are the added ones; the host login is not among them.
        account.id !== DEFAULT_AGENT_ACCOUNT_ID &&
        (account.platform === "claude" || account.platform === "codex")
          ? [
              {
                provider: account.platform,
                accountId: account.id,
                home: agentAccountHome(root, account.platform, account.id),
              },
            ]
          : [],
      );
    },
    containerDelivery: async (environmentId) => {
      const environment = await context.storage.getEnvironment(environmentId);
      if (!environment?.containerId) return null;
      const dataDir = context.storage.getDataDir();
      return readContainerCapabilityDelivery(
        {
          label: containerLabel,
          manifestExtensions: async (revision) =>
            (await readInputsManifest(dataDir, environmentId, revision))?.extensions,
        },
        environment.containerId,
        {
          inputsRevision: DOCKER_LABEL_INPUTS_REVISION,
          capabilitiesDigest: DOCKER_LABEL_CAPABILITIES_DIGEST,
        },
      );
    },
  };
}
