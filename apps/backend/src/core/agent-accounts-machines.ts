import {
  HOST_SIGN_IN_PLATFORMS,
  type AgentAccountsSnapshot,
  type HostAgentSignIns,
  type MachineAgentAccounts,
  type MachineAgentAccountsResult,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandContext } from "./commands-context.js";
import { listAgentAccounts } from "./agent-accounts.js";
import { readHostAgentSignIns } from "./agent-sign-ins.js";
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
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as AgentAccountsSnapshot).accounts) &&
    typeof (value as AgentAccountsSnapshot).active === "object"
  );
}

/** Rebuilt field by field: another machine's answer is never passed through. */
function parseSignIns(value: unknown): HostAgentSignIns | undefined {
  if (!value || typeof value !== "object") return undefined;
  const signIns: HostAgentSignIns = {};
  for (const platform of HOST_SIGN_IN_PLATFORMS) {
    const entry = (value as Record<string, unknown>)[platform];
    if (!entry || typeof entry !== "object") continue;
    const { state, source } = entry as { state?: unknown; source?: unknown };
    if (state !== "signed-in" && state !== "signed-out") continue;
    signIns[platform] = {
      state,
      ...(typeof source === "string" && source ? { source: source.slice(0, 120) } : {}),
    };
  }
  return signIns;
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
  options: { timeoutMs?: number; readSignIns?: () => Promise<HostAgentSignIns> } = {},
): Promise<MachineAgentAccountsResult> {
  const timeoutMs = options.timeoutMs ?? MACHINE_ACCOUNTS_TIMEOUT_MS;
  const [profile, selfId, snapshot, signIns] = await Promise.all([
    context.storage.getBackendProfile(),
    context.nodes?.selfIdentity().catch(() => null) ?? Promise.resolve(null),
    listAgentAccounts(context),
    (options.readSignIns ?? readHostAgentSignIns)(),
  ]);
  const self: MachineAgentAccounts = {
    nodeId: selfId ?? "self",
    name: profile.displayName,
    colorToken: profile.colorToken,
    self: true,
    state: "ok",
    snapshot,
    signIns,
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
        // A machine that predates the sign-in read still lists its accounts.
        const signIns = withTimeout(
          portal.invokeOnNode({
            nodeId: view.nodeId,
            command: "read_host_agent_sign_ins",
            args: {},
          }),
          timeoutMs,
        ).then(
          (routed) => (routed.outcome === "ok" ? parseSignIns(routed.result) : undefined),
          () => undefined,
        );
        try {
          const routed = await withTimeout(
            portal.invokeOnNode({ nodeId: view.nodeId, command: "list_agent_accounts", args: {} }),
            timeoutMs,
          );
          if (routed.outcome !== "ok" || !isSnapshot(routed.result)) {
            return { ...base, state: "unavailable" };
          }
          const read = await signIns;
          return {
            ...base,
            state: "ok",
            snapshot: routed.result,
            ...(read ? { signIns: read } : {}),
          };
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
