import type { CreateTabOptions } from "@/contexts/TerminalContext";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  graphActivationRetryRefusal,
  graphActivationSkipRefusal,
  graphRunActions,
} from "@orkestrator/protocol/graphs/run-view";
import {
  graphRunCodeRewindBlocker,
  graphRunRestartBlocker,
} from "@orkestrator/protocol/graphs/run-rewind";
import type { GraphRunFlowNode } from "./graph-run-flow";

/**
 * Which actions the run view offers for a node (plan P2.11): retry, restart
 * from here, rewind code to here, skip, open session, and the run-wide
 * pause, resume and cancel. Pure, so the faces, the context menus and the
 * inspector agree, and the backend's own checks decide the same way: retry
 * and skip by `run-view.ts`, restart and code rewind by item 210's
 * `graphRunRestartBlocker` and `graphRunCodeRewindBlocker`. "Rewind code to
 * here" stays listed, disabled with the reason, when only the code rewind is
 * refused (a running run must be paused first), so the way to it is visible.
 * Approve, edit and choose live in the human node's inspector slot (item 208).
 */
export type GraphRunActionKey =
  | "expand-attempt"
  | "collapse-attempt"
  | "open-session"
  | "retry"
  | "restart"
  | "rewind-code"
  | "skip"
  | "pause"
  | "resume"
  | "cancel";

export interface GraphRunActionSpec {
  key: GraphRunActionKey;
  label: string;
  /** Run-wide controls sit after the node's own actions. */
  runWide?: boolean;
  /** Listed but refused now, and why (shown as the control's title). */
  disabledReason?: string;
}

/** The activation's input `workspace@1` commit a code rewind resets to, when it has one. */
export function graphActivationWorkspaceInput(
  run: GraphRun,
  activation: NodeActivation,
): string | null {
  const node = run.plan.nodes.find((candidate) => candidate.id === activation.nodeId);
  for (const port of node?.inputs ?? []) {
    if (port.type !== "workspace@1") continue;
    const bound = activation.inputs[port.name];
    if (typeof bound === "string") return bound;
  }
  return null;
}

export function graphRunNodeActions(run: GraphRun, node: GraphRunFlowNode): GraphRunActionSpec[] {
  const actions: GraphRunActionSpec[] = [];
  if (node.kind === "attempt") {
    actions.push(
      node.attemptExpanded
        ? { key: "collapse-attempt", label: "Hide activations" }
        : { key: "expand-attempt", label: "Show activations" },
    );
  }
  const activation = node.activation;
  if (activation?.session?.providerSessionId) {
    actions.push({ key: "open-session", label: "Open session" });
  }
  if (activation && node.kind === "position") {
    if (graphActivationRetryRefusal(run, activation) === null) {
      actions.push({ key: "retry", label: "Retry" });
    }
    // A position not reached yet has nothing to restart; skip covers it.
    const started = activation.state !== "waiting" && activation.state !== "ready";
    if (started && graphRunRestartBlocker(run, activation.key) === undefined) {
      actions.push({ key: "restart", label: "Restart from here" });
      if (graphActivationWorkspaceInput(run, activation)) {
        const blocked = graphRunCodeRewindBlocker(run, activation.key);
        actions.push({
          key: "rewind-code",
          label: "Rewind code to here…",
          ...(blocked ? { disabledReason: blocked } : {}),
        });
      }
    }
    if (graphActivationSkipRefusal(run, activation) === null) {
      actions.push({ key: "skip", label: "Skip" });
    }
  }
  const wide = graphRunActions(run);
  if (wide.pause) actions.push({ key: "pause", label: "Pause run", runWide: true });
  if (wide.resume) actions.push({ key: "resume", label: "Resume run", runWide: true });
  if (wide.cancel) actions.push({ key: "cancel", label: "Cancel run…", runWide: true });
  return actions;
}

/** A tab attached to an agent activation's own provider session. */
export function graphRunSessionTabOptions(
  run: Pick<GraphRun, "id">,
  node: Pick<GraphRunFlowNode, "title">,
  activation: NodeActivation,
): CreateTabOptions | null {
  const session = activation.session;
  if (!session?.providerSessionId) return null;
  return {
    tabId: `graph-run-session:${run.id}:${activation.key}`,
    activateExistingTab: true,
    agentLaunchMode: "native",
    resumeSessionId: session.providerSessionId,
    displayTitle: `Graph · ${node.title}`,
    hideStructuredOutput: true,
    initialAgentModel: session.model,
    initialReasoningEffort: session.effort,
    initialConversationMode: session.turnMode === "read-only" ? "plan" : "build",
    // The run owns this session. Seeding a fresh one in its place would show
    // an empty tab that looks like the run's work.
    requireExistingResumeSession: true,
  };
}
