import type {
  AgentAccountsSnapshot,
  MachineAgentAccounts,
  MachineAgentAccountsResult,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandContext } from "./commands-context.js";
import { listAgentAccounts } from "./agent-accounts.js";
import { NodeUnavailableError } from "./nodes/node-link.js";

/** How long one machine may take to list its accounts before it is shown as unavailable. */
const MACHINE_ACCOUNTS_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NodeUnavailableError("timed out")), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isSnapshot(value: unknown): value is AgentAccountsSnapshot {
  if (!value || typeof value !== "object") return false;
  const { accounts, active } = value as Partial<AgentAccountsSnapshot>;
  return (
    Array.isArray(accounts) &&
    active !== null &&
    typeof active === "object" &&
    !Array.isArray(active) &&
    typeof active.claude === "string" &&
    typeof active.codex === "string"
  );
}

/**
 * Every machine's agent accounts, for the command node's accounts overview.
 *
 * This node answers for itself; each connected machine it commands answers
 * through its own `list_agent_accounts`, asked in parallel and bounded by a
 * timeout. A machine that cannot answer is listed as unavailable rather than
 * failing the whole read. A node in leaf mode lists only itself: its own
 * machines are its command node's to manage.
 */
export async function listMachineAgentAccounts(
  context: CommandContext,
  options: { timeoutMs?: number } = {},
): Promise<MachineAgentAccountsResult> {
  const timeoutMs = options.timeoutMs ?? MACHINE_ACCOUNTS_TIMEOUT_MS;
  const [profile, selfId, snapshot] = await Promise.all([
    context.storage.getBackendProfile(),
    context.nodes?.selfIdentity().catch(() => null) ?? Promise.resolve(null),
    listAgentAccounts(context),
  ]);
  const self: MachineAgentAccounts = {
    nodeId: selfId ?? "self",
    name: profile.displayName,
    colorToken: profile.colorToken,
    self: true,
    state: "ok",
    snapshot,
  };
  const nodes = context.nodes;
  const portal = context.nodePortal;
  if (!nodes || !portal || nodes.isLeaf()) return { machines: [self] };

  const { nodes: views } = await nodes.listNodes();
  const others = await Promise.all(
    views
      .filter((view) => view.enabled && !view.detachPending)
      .map(async (view): Promise<MachineAgentAccounts> => {
        const base = {
          nodeId: view.nodeId,
          name: view.displayName,
          ...(view.colorToken ? { colorToken: view.colorToken } : {}),
          self: false,
        };
        try {
          const routed = await withTimeout(
            portal.invokeOnNode({ nodeId: view.nodeId, command: "list_agent_accounts", args: {} }),
            timeoutMs,
          );
          if (routed.outcome !== "ok" || !isSnapshot(routed.result)) {
            return { ...base, state: "unavailable" };
          }
          return { ...base, state: "ok", snapshot: routed.result };
        } catch (error) {
          if (error instanceof NodeUnavailableError) return { ...base, state: "unavailable" };
          return {
            ...base,
            state: "error",
            error: error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
          };
        }
      }),
  );
  return { machines: [self, ...others] };
}
