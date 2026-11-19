/**
 * This backend's worktrees, added accounts and containers, as scoped
 * delivery reads them (`scoped-delivery.ts`, `container-staging.ts`).
 * Nothing here writes: environments and accounts are listed, and a
 * container's record is read from its labels and its inputs revision.
 */
import { DEFAULT_AGENT_ACCOUNT_ID } from "@orkestrator/protocol/agent-accounts";

import { agentAccountHome } from "../agent-accounts-homes.js";
import type { CommandContext } from "../commands-context.js";
import { DOCKER_LABEL_CAPABILITIES_DIGEST, DOCKER_LABEL_INPUTS_REVISION } from "../constants.js";
import { containerLabel } from "../portable-input-status.js";
import { readInputsManifest } from "../portable-inputs.js";
import { readContainerCapabilityDelivery } from "./container-staging.js";
import type { ScopedAccount, ScopedTargetSources } from "./scoped-delivery.js";

export function capabilityScopedSources(context: CommandContext): ScopedTargetSources {
  return {
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
