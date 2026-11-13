/**
 * A coordinator's `list_nodes` tool against a real command node (to-do 1030
 * (retired) tasks 2 and 7): the production tool handler
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
  /** Always present, `null` when the build reports none; optional here so an omission is visible. */
  readonly buildCommit?: string | null;
  readonly hasProject: boolean;
  readonly machine: ListedMachine;
}

export interface ListNodesResult {
  readonly self: {
    readonly nodeId: string;
    readonly version: string;
    /**
     * The handler's own `BUILD_COMMIT`: the process that runs the handler,
     * which in qualification is the runner, not the command node.
     */
    readonly buildCommit: string | null;
    readonly machine: ListedMachine;
  };
  readonly nodes: readonly ListedNode[];
}

/** The Web platform the invoker uses; a test under Happy DOM passes Bun's own. */
export interface InvokerPlatform {
  readonly fetch: typeof fetch;
  readonly AbortSignal: typeof AbortSignal;
}

/** The invoker the tool handler calls, over `node`'s gateway with the caller's signal. */
export function gatewayInvoker(
  node: Pick<PeerNode, "origin" | "token">,
  platform: InvokerPlatform = { fetch: globalThis.fetch, AbortSignal: globalThis.AbortSignal },
): ControlMcpInvoker {
  return async <T>(
    command: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal },
  ): Promise<T> => {
    const timeout = platform.AbortSignal.timeout(120_000);
    const signal = options?.signal ? platform.AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await platform.fetch(`${node.origin}/__orkestrator/invoke`, {
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

/** What NO-C8 saw: the listed field exactly as it arrived, and whether it matches. */
export interface BuildCommitCheck {
  readonly passed: boolean;
  /** The listed `buildCommit`, or `"absent"` when the entry or the field is missing. */
  readonly observed: string | null;
  readonly expected: string | null;
}

/**
 * A listed node's `buildCommit` against its hello. `list_nodes` promises the
 * field on every entry, `null` when the build reports none, so an entry that
 * omits it fails even when the hello has no commit either.
 */
export function buildCommitCheck(
  entry: ListedNode | undefined,
  helloBuildCommit: string | undefined,
): BuildCommitCheck {
  const expected = helloBuildCommit ?? null;
  if (!entry || !Object.hasOwn(entry, "buildCommit")) {
    return { passed: false, observed: "absent", expected };
  }
  const observed = entry.buildCommit;
  if (observed !== null && typeof observed !== "string") {
    return { passed: false, observed: String(observed), expected };
  }
  return { passed: observed === expected, observed, expected };
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
