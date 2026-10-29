import {
  normalizePreferredEmail,
  parseHostAgentSignIns,
  parseAgentAccountsSnapshot,
  type AgentAccountPlatform,
  type HostAgentSignIns,
  type MachineAgentAccounts,
  type MachineAgentAccountsResult,
  type PreferredAgentIdentities,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandContext } from "./commands-context.js";
import { listAgentAccounts } from "./agent-accounts.js";
import { readHostAgentSignIns } from "./agent-sign-ins.js";
import { NodeUnavailableError } from "./nodes/index.js";

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
  const [profile, selfId, snapshot, signIns, store] = await Promise.all([
    context.storage.previewServices.getBackendProfile(),
    context.nodes?.selfIdentity().catch(() => null) ?? Promise.resolve(null),
    listAgentAccounts(context),
    (options.readSignIns ?? readHostAgentSignIns)(),
    context.storage.agentAccounts.loadAgentAccounts(),
  ]);
  const preferred = store.preferred ? { preferred: { ...store.preferred } } : {};
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
  if (!nodes || !portal || nodes.isLeaf()) return { machines: [self], ...preferred };

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
          (routed) => (routed.outcome === "ok" ? parseHostAgentSignIns(routed.result) : undefined),
          () => undefined,
        );
        try {
          const routed = await withTimeout(
            portal.invokeOnNode({ nodeId: view.nodeId, command: "list_agent_accounts", args: {} }),
            timeoutMs,
          );
          if (routed.outcome !== "ok") {
            return { ...base, state: "unavailable" };
          }
          const snapshot = parseAgentAccountsSnapshot(routed.result);
          if (!snapshot) return { ...base, state: "error", error: "Invalid account snapshot" };
          const read = await signIns;
          return {
            ...base,
            state: "ok",
            snapshot,
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
  return { machines: [self, ...others], ...preferred };
}

/**
 * Record (or, with `email` null, clear) the login the user wants every
 * machine on for a platform. Kept by this machine, the one whose overview
 * asks; it switches nothing and is never sent to another machine.
 */
export async function setPreferredAgentIdentity(
  context: CommandContext,
  platform: AgentAccountPlatform,
  email: string | null,
): Promise<PreferredAgentIdentities> {
  const normalized = email === null ? undefined : normalizePreferredEmail(email);
  if (email !== null && !normalized) throw new Error("A preferred login needs a valid email");
  return context.storage.agentAccounts.mutateAgentAccounts((store) => {
    const next: PreferredAgentIdentities = { ...store.preferred };
    if (normalized) next[platform] = normalized;
    else delete next[platform];
    const { preferred: _previous, ...rest } = store;
    return {
      store: Object.keys(next).length ? { ...rest, preferred: next } : rest,
      result: next,
    };
  });
}
