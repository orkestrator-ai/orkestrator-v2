/** Credential-free host approvals through production normalization and enforcement. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeApproval,
  buildApprovalResponse,
} from "../../bridges/codex-bridge/src/app-server/approvals";
import { HttpBridgeInteractionAdapter } from "../../apps/backend/src/core/http-bridge-interactions";
import {
  PermissionRuleEnforcer,
  type PermissionRuleChoice,
} from "../../apps/backend/src/core/permission-rules/enforcer";
import { StorageService } from "../../apps/backend/src/core/storage";
import type { PersistedNativeAgentSession, Environment } from "../../apps/backend/src/core/models";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";

export async function createCodexHostFixture() {
  const home = mkdtempSync(path.join(tmpdir(), "codex-host-rules-"));
  const storage = new StorageService(home);
  await storage.init();
  const store = storage.permissionRuleStore();
  const session = {
    version: 1,
    key: "host-session",
    environmentId: "host-env",
    agent: "codex",
    logicalSessionKey: "host-tab",
    providerSessionId: "thread-host",
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    policy: {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as PersistedNativeAgentSession;
  let pending: ReturnType<typeof describeApproval>[] = [];
  const wireResponses: unknown[] = [];
  let serial = 0;
  const adapter = new HttpBridgeInteractionAdapter(
    "codex",
    { agent: "codex", baseUrl: "http://fixture", authToken: "fixture" },
    (async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/approvals")) return Response.json({ approvals: pending });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      const approval = pending.find((entry) => url.endsWith(`/approvals/${entry.approvalId}`));
      if (!approval) return new Response("unknown request", { status: 404 });
      const { decision } = JSON.parse(String(init.body));
      wireResponses.push(
        buildApprovalResponse("item/commandExecution/requestApproval", decision, {}),
      );
      pending = pending.filter((entry) => entry !== approval);
      return Response.json({ status: "applied", decision });
    }) as typeof fetch,
  );
  const provider = { interactions: adapter };
  const enforcer = new PermissionRuleEnforcer({
    store: () => store,
    now: Date.now,
    getEnvironment: async () =>
      ({
        id: "host-env",
        projectId: "host-project",
        environmentType: "local",
        worktreePath: home,
      }) as Environment,
  });
  return {
    wireResponses,
    raise() {
      pending.push(
        describeApproval({
          approvalId: `host-${++serial}`,
          method: "item/commandExecution/requestApproval",
          generation: 1,
          requestedAt: Date.now(),
          expiresAt: Date.now() + 300_000,
          params: {
            threadId: "thread-host",
            turnId: `turn-${serial}`,
            itemId: `item-${serial}`,
            networkApprovalContext: {
              host: "registry.npmjs.org",
              protocol: "https",
            },
          },
        }),
      );
    },
    async snapshot() {
      return (
        await enforcer.apply(
          session,
          provider,
          await adapter.listPendingInteractions("thread-host"),
        )
      ).snapshot;
    },
    async remember(id: string, choice: PermissionRuleChoice) {
      return (await enforcer.approveAndRemember(session, provider, id, choice)).outcome;
    },
    detail(id: string) {
      return adapter.permissionRuleDetail("thread-host", id);
    },
    rules: () => store.list(),
    remove() {
      for (const rule of store.list()) store.delete(rule.id);
    },
    close() {
      storage.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
