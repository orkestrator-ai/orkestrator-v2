/**
 * Fault seam for slash-command restart qualification. The bridge really accepted
 * this ID; erase only the backend acknowledgement to model a lost response,
 * restoring the durable parked record that an interrupted dispatch leaves.
 * Run under Bun from the Playwright spec, never imported by Node.
 */
import { openBackendDatabase } from "../../apps/backend/src/core/storage-stores";
import type { PersistedNativeAgentSession } from "../../apps/backend/src/core/models";

const [dataDir, environmentId, agent, logicalSessionKey, requestId, prompt] = process.argv.slice(2);
if (
  !dataDir ||
  !environmentId ||
  agent !== "claude" ||
  !logicalSessionKey ||
  !requestId ||
  !prompt
) {
  throw new Error("Expected isolated data directory and Claude dispatch identity");
}
const database = openBackendDatabase(dataDir);
try {
  const sessions = database.readStore("native-agent-sessions")?.value as
    Record<string, PersistedNativeAgentSession> | undefined;
  const key = Object.entries(sessions ?? {}).find(
    ([, session]) =>
      session.environmentId === environmentId &&
      session.agent === agent &&
      session.logicalSessionKey === logicalSessionKey,
  )?.[0];
  if (!key) throw new Error("The fixture session was not found");
  database.updateStoreRow("native-agent-sessions", key, (current) => {
    const session = current as PersistedNativeAgentSession | undefined;
    if (
      !session ||
      session.environmentId !== environmentId ||
      !session.dispatchedRequestIds?.includes(requestId)
    ) {
      throw new Error("The fixture dispatch was not acknowledged");
    }
    return {
      result: undefined,
      value: {
        ...session,
        dispatchedRequestIds: session.dispatchedRequestIds.filter((id) => id !== requestId),
        pendingDispatch: { requestId, prompt, createdAt: new Date().toISOString() },
      },
    };
  });
} finally {
  database.close();
}
