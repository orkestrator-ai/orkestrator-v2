/**
 * A coordinator's `list_nodes` tool against a real command node (to-do 1030
 * tasks 2 and 7): the production tool handler
 * (`apps/backend/src/core/control-mcp/nodes.ts`), with its invoker sending
 * each command to the node's gateway, which is what the Control MCP server's
 * invoker does in process. The per-node load read keeps its 2 s limit and its
 * abort, so a slow or older leaf is shown the way a coordinator would see it.
 *
 * Only a command node of this checkout can run it: the handler is this
 * checkout's code, and an older command node would answer with its own.
 */
import { registerNodeTools } from "../../../apps/backend/src/core/control-mcp/nodes.ts";
import type { ControlMcpInvoker } from "../../../apps/backend/src/core/control-shared-actions.ts";
import { InvokeError, type PeerNode } from "../harness.ts";

/** One machine's `machine` field, as far as the scenario reads it. */
export interface ListedMachine {
  readonly status: string;
  readonly reason?: string;
  readonly osFamily?: string;
  readonly os?: string;
  readonly cpuCores?: number;
  readonly totalRamGb?: number;
  readonly latestSampleAgeSeconds?: number | null;
  readonly load?: ReadonlyArray<{
    readonly window: string;
    readonly windowSeconds: number;
    readonly coveredSeconds: number;
    readonly cpuPercent: number | null;
    readonly ramPercent: number | null;
  }>;
}

export interface ListedNode {
  readonly nodeId: string;
  readonly available: boolean;
  readonly state: string;
  readonly version: string | null;
  readonly buildCommit: string | null;
  readonly hasProject: boolean;
  readonly machine: ListedMachine;
}

export interface ListNodesResult {
  readonly self: {
    readonly nodeId: string;
    readonly version: string;
    readonly buildCommit: string | null;
    readonly machine: ListedMachine;
  };
  readonly nodes: readonly ListedNode[];
}

/** The invoker the tool handler calls, over `node`'s gateway with the caller's signal. */
export function gatewayInvoker(node: PeerNode): ControlMcpInvoker {
  return async <T>(
    command: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal },
  ): Promise<T> => {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const response = await fetch(`${node.origin}/__orkestrator/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
      signal,
    });
    const text = await response.text();
    let payload: { result?: T; error?: unknown } | null = null;
    try {
      payload = JSON.parse(text) as { result?: T; error?: unknown };
    } catch {
      payload = null;
    }
    if (response.status !== 200) {
      const error = payload?.error;
      const message =
        typeof error === "string"
          ? error
          : typeof (error as { message?: unknown } | null)?.message === "string"
            ? (error as { message: string }).message
            : text;
      throw new InvokeError(command, { status: response.status, message: message.slice(0, 500) });
    }
    return payload?.result as T;
  };
}

/** Call `list_nodes` as the coordinator of `projectId` on `command`. */
export async function coordinatorListNodes(
  command: PeerNode,
  projectId: string,
): Promise<ListNodesResult> {
  const handlers = new Map<string, () => Promise<{ structuredContent: unknown }>>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: () => Promise<{ structuredContent: unknown }>,
    ) {
      handlers.set(name, handler);
    },
  };
  registerNodeTools(server as never, gatewayInvoker(command), {
    projectId,
    coordinatorId: "qualification",
    conversationId: "qualification",
  });
  const listNodes = handlers.get("list_nodes");
  if (!listNodes) throw new Error("registerNodeTools registered no list_nodes");
  return (await listNodes()).structuredContent as ListNodesResult;
}

/** Whether a machine reports figures from at least one reading. */
export function hasReadings(machine: ListedMachine | undefined): boolean {
  if (machine?.status !== "ok") return false;
  const short = machine.load?.[0];
  return (
    typeof machine.latestSampleAgeSeconds === "number" &&
    typeof machine.cpuCores === "number" &&
    machine.cpuCores > 0 &&
    typeof machine.totalRamGb === "number" &&
    machine.totalRamGb > 0 &&
    typeof machine.os === "string" &&
    machine.os.length > 0 &&
    short !== undefined &&
    short.coveredSeconds > 0 &&
    typeof short.cpuPercent === "number" &&
    typeof short.ramPercent === "number"
  );
}

/** The figures worth recording: no paths, names or tokens. */
export function machineEvidence(machine: ListedMachine | undefined): Record<string, unknown> {
  if (!machine) return { status: "absent" };
  if (machine.status !== "ok") return { status: machine.status, reason: machine.reason ?? null };
  return {
    status: "ok",
    osFamily: machine.osFamily ?? null,
    os: machine.os ?? null,
    cpuCores: machine.cpuCores ?? null,
    totalRamGb: machine.totalRamGb ?? null,
    latestSampleAgeSeconds: machine.latestSampleAgeSeconds ?? null,
    load: (machine.load ?? []).map((entry) => ({
      window: entry.window,
      coveredSeconds: entry.coveredSeconds,
      cpuPercent: entry.cpuPercent,
      ramPercent: entry.ramPercent,
    })),
  };
}
