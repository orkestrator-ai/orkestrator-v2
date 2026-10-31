import {
  MACHINE_LOAD_COMMAND,
  parseMachineLoadReport,
  type MachineLoadView,
  type MachineUnavailableReason,
} from "@orkestrator/protocol/machine-load";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * Each machine's OS and load for `list_nodes`. A read is one round trip to a
 * value the machine already holds, so a machine that takes longer than this is
 * shown as unavailable rather than holding up the list.
 */
export const MACHINE_LOAD_NODE_TIMEOUT_MS = 2_000;

function unavailable(reason: MachineUnavailableReason, detail: string): MachineLoadView {
  return { status: "unavailable", reason, detail };
}

/** Both wordings: a real backend's, and the plainer one some node peers answer with. */
function isUnknownCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes(`Unknown backend command: ${MACHINE_LOAD_COMMAND}`) ||
    message.includes(`Unknown command: ${MACHINE_LOAD_COMMAND}`)
  );
}

function viewOf(value: unknown): MachineLoadView {
  const report = parseMachineLoadReport(value);
  return report
    ? { status: "ok", ...report }
    : unavailable("error", "The machine returned no readable load.");
}

export async function readOwnMachineLoad(invoke: ControlMcpInvoker): Promise<MachineLoadView> {
  return invoke<unknown>(MACHINE_LOAD_COMMAND).then(viewOf, () =>
    unavailable("error", "This machine's load could not be read."),
  );
}

/**
 * One node's OS and load. Failures keep to fixed wording, so nothing a node's
 * error happens to say (a path, a host) reaches the coordinator.
 */
export async function readNodeMachineLoad(
  invoke: ControlMcpInvoker,
  node: { nodeId: string; name: string; available: boolean },
  timeoutMs = MACHINE_LOAD_NODE_TIMEOUT_MS,
): Promise<MachineLoadView> {
  if (!node.available) {
    return unavailable("offline", `${node.name} is not connected, so its load is unknown.`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<MachineLoadView>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          unavailable("timeout", `${node.name} did not report its load within ${timeoutMs} ms.`),
        ),
      timeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();
  });
  const read = invoke<{ outcome?: string; result?: unknown }>("invoke_on_node", {
    nodeId: node.nodeId,
    command: MACHINE_LOAD_COMMAND,
    args: {},
  }).then(
    (routed) =>
      routed?.outcome === "ok"
        ? viewOf(routed.result)
        : unavailable("error", `The connection to ${node.name} was lost before it answered.`),
    (error: unknown) => {
      if (isUnknownCommand(error)) {
        compatibilityPathUsage.record("machine-load.older-node");
        return unavailable(
          "older-version",
          `${node.name} runs an older Orkestrator that does not report its load; update it to see this.`,
        );
      }
      // The link dropped after the summaries were read.
      if ((error as { code?: unknown } | null)?.code === "node-unavailable") {
        return unavailable("offline", `${node.name} is not connected, so its load is unknown.`);
      }
      return unavailable("error", `${node.name} could not report its load.`);
    },
  );
  return Promise.race([read, timedOut]).finally(() => clearTimeout(timer));
}
