import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
  type CoordinatorConversation,
} from "@orkestrator/protocol/coordinator";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import type { setup } from "./test-provider.js";

function conversation(
  coordinatorId: string,
  id: string,
  fields: Partial<CoordinatorConversation> = {},
): CoordinatorConversation {
  const tabId = `coordinator-${id}`;
  return {
    id,
    tabId,
    logicalSessionKey: coordinatorConversationSessionKey(coordinatorId, { id, tabId }),
    agent: "claude",
    title: "Coordinator",
    createdAt: new Date(0).toISOString(),
    mailboxIncarnationId: `incarnation-${id}`,
    role: "main",
    ...fields,
  };
}

export async function seedCoordinator(
  session: Awaited<ReturnType<typeof setup>>,
  options: { adopt?: boolean } = {},
) {
  const { harness, projectId } = session;
  await harness.storage.updateProject(projectId, { localPath: harness.root });
  const coordinatorId = "coordinator-1";
  await harness.storage.coordinators.mutateCoordinatorWorkspace(projectId, () => ({
    version: COORDINATOR_WORKSPACE_VERSION,
    id: coordinatorId,
    projectId,
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: [
      conversation(coordinatorId, "main"),
      conversation(coordinatorId, "unassigned", { agent: undefined, role: "side", sideOrdinal: 1 }),
      conversation(coordinatorId, "closed", {
        role: "side",
        sideOrdinal: 2,
        closedAt: new Date(0).toISOString(),
      }),
    ],
    selectedConversationId: "main",
    repositoryContextRevision: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  const environmentId = coordinatorRuntimeId(coordinatorId, "main");
  const tabId = "coordinator-main";
  const sessionId = encodePublicSessionId(environmentId, tabId);
  const providerSessionId = "provider-coordinator";
  if (options.adopt !== false) {
    await harness.commands.get("adopt_native_agent_session")!(
      {
        environmentId,
        agent: "claude",
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        providerSessionId,
        origin: "interactive-native",
      },
      harness.context,
    );
  }
  return { ...session, coordinatorId, environmentId, tabId, sessionId, providerSessionId };
}
