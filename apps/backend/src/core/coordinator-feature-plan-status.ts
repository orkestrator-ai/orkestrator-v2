/**
 * A feature plan's planning exchange reduced to a coordinator status (todo
 * 0395 task 3): what a coordinator that sent a message with
 * `launch_feature_plan` hears through its status wake
 * (`coordinator-status-wakes.ts`, `feature-plan` associations).
 *
 * The association names one exchange (`featurePlan.operationId`); the plan
 * itself takes many messages from the user and the coordinator alike.
 *
 * - **Reply ready.** The planning agent's answer to that exchange is on the
 *   plan and was applied: a question to answer, a summary to confirm, or the
 *   stories. Once, terminal for the association. A successful exchange
 *   detaches its planning record, so the reply is found on the plan: an
 *   applied assistant message after the exchange's own user message (whose
 *   id is the operation id), before any later user message.
 * - **Failed.** The exchange stopped on an error. One notice per failure
 *   (keyed by when it occurred), not terminal: the user can retry it from the
 *   Features board, and the retry's reply or failure is reported too.
 *
 * Both are sent whatever the wake setting, as every terminal workflow notice
 * is. Dispatching, running and persisting are progress, not a status. A
 * cancelled exchange, a deleted plan, or a reply whose state block never
 * applied (its failure was already reported) ends the association without a
 * wake: the user did it, or it is old news.
 *
 * Details are content-free: the plan's title, status, story count and the
 * exchange's bounded failure message, never the reply or the user's message.
 * `get_feature_plan` reads those.
 */
import { createHash } from "node:crypto";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import { isFeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";
import type { CoordinatorStatus, CoordinatorStatusResource } from "./coordinator-status-wakes.js";
import type { FeaturePlan, FeaturePlanMessage, StorageService } from "./storage.js";

export type FeaturePlanObservation =
  | { status: CoordinatorStatus }
  /** Nothing more will be reported for this exchange. */
  | { ended: "missing" | "cancelled" }
  /** Still planning. */
  | null;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function bounded(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Whether the exchange's user message has an applied assistant reply before
 * the next user message. A reply whose state block is still pending, or that
 * a retry's reply superseded, does not count.
 */
function hasAppliedReply(
  messages: readonly FeaturePlanMessage[],
  operationId: string,
): boolean | "missing" {
  const index = messages.findIndex((entry) => entry.id === operationId);
  if (index < 0) return "missing";
  for (const entry of messages.slice(index + 1)) {
    if (entry.role === "user") return false;
    if (
      entry.role === "assistant" &&
      entry.stateApplication !== "pending" &&
      entry.stateApplication !== "superseded"
    )
      return true;
  }
  return false;
}

function facts(plan: FeaturePlan): string[] {
  return [
    `Plan: ${bounded(plan.title, 120)} (status ${plan.status}).`,
    ...(plan.stories.length
      ? [`${plan.stories.length} stor${plan.stories.length === 1 ? "y" : "ies"} on the plan.`]
      : []),
  ];
}

function tools(plan: FeaturePlan): string[] {
  return [`get_feature_plan { "featureId": "${plan.id}" }`];
}

function readyStatus(plan: FeaturePlan): CoordinatorStatus {
  const answer =
    plan.status === "collecting" || plan.status === "confirming"
      ? [
          `To answer, call launch_feature_plan { "featureId": "${plan.id}", "message": "…", "requestId": "…" } with a new requestId.`,
        ]
      : [];
  return {
    key: "ready",
    state: "ready",
    tone: plan.status === "collecting" || plan.status === "confirming" ? "attention" : "success",
    terminal: true,
    headline: "has a planning reply ready",
    details: [...facts(plan), ...answer],
    tools: tools(plan),
    mode: "off",
  };
}

/** The status of the exchange `operationId` on `plan` for its coordinator. */
export function featurePlanCoordinatorStatus(
  plan: FeaturePlan | null,
  operationId: string,
): FeaturePlanObservation {
  if (!plan) return { ended: "missing" };
  const record =
    isFeaturePlanningRecord(plan.planning) && plan.planning.operationId === operationId
      ? plan.planning
      : undefined;
  if (record?.phase === "failed") {
    const failure = record.failure;
    return {
      status: {
        key: `failed:${hash(`${failure?.occurredAt ?? record.updatedAt}:${failure?.code ?? ""}`)}`,
        state: "failed",
        tone: "failure",
        terminal: false,
        headline: "planning failed",
        details: [
          ...facts(plan),
          ...(failure ? [`Error (${failure.code}): ${bounded(failure.message, 300)}`] : []),
          "The user can retry it from the Features board; its reply is reported here too.",
        ],
        tools: tools(plan),
        mode: "off",
      },
    };
  }
  // Applied, and only consuming the tool-mode result remains.
  const applied = record ? Boolean(record.resultAppliedAt) || record.phase === "complete" : true;
  if (!applied) return null;
  const reply = hasAppliedReply(plan.messages, operationId);
  if (reply === "missing") return { ended: "missing" };
  if (reply) return { status: readyStatus(plan) };
  // Detached without an applied reply: cancelled, or a parse failure retried away.
  return record ? null : { ended: "cancelled" };
}

export interface FeaturePlanWakeDependencies {
  storage: StorageService;
  /** Places one notice when the wake setting allows it; false when nothing was placed. */
  send(resource: CoordinatorStatusResource, status: CoordinatorStatus): Promise<boolean>;
  /** Records the key sent, so the same status is never sent twice. */
  recordNotice(key: string): Promise<void>;
}

/**
 * Observe one `feature-plan` association: send its status once, and stop
 * observing it after a terminal status or when it ended. Feature plans live on
 * this node only, so an association naming another node is skipped.
 */
export async function observeCoordinatorFeaturePlan(
  association: CoordinatorWorkflowAssociation,
  dependencies: FeaturePlanWakeDependencies,
): Promise<void> {
  const operationId = association.featurePlan?.operationId;
  if (association.nodeId || !operationId) return;
  const { storage } = dependencies;
  const stored = await storage.kanban.getFeaturePlan(association.resourceId);
  const plan = stored?.projectId === association.projectId ? stored : null;
  if (association.pending) {
    // A crash may leave the reservation pending after the exchange attached.
    // Missing operation evidence during startup is not evidence it ended.
    if (
      !plan ||
      (plan.planning?.operationId !== operationId &&
        !plan.messages.some((entry) => entry.id === operationId))
    )
      return;
    await storage.coordinators.completeCoordinatorWorkflowAssociation(
      association.id,
      association.resourceId,
    );
  }
  const observed = featurePlanCoordinatorStatus(plan, operationId);
  if (!observed) return;
  if ("ended" in observed) {
    await storage.coordinators.markCoordinatorWorkflowNotified(association.id, 0);
    return;
  }
  const { status } = observed;
  if (association.statusNotice?.key !== status.key) {
    const sent = await dependencies.send(
      { kind: "feature-plan", id: association.resourceId, label: plan!.title },
      status,
    );
    if (!sent) return;
    await dependencies.recordNotice(status.key);
  }
  if (status.terminal)
    await storage.coordinators.markCoordinatorWorkflowNotified(association.id, 0);
}

/**
 * A `feature-plan` association's follow for `list_workflows`: whether it is
 * still followed and the last state reported (`ready` or `failed`). Content-free.
 */
export function featurePlanFollowSummary(association: Record<string, unknown>): {
  following: boolean;
  lastReportedState: string | null;
} {
  const notice = association.statusNotice;
  const key =
    notice && typeof notice === "object" && typeof (notice as { key?: unknown }).key === "string"
      ? (notice as { key: string }).key
      : null;
  return {
    following: !association.terminalNotifiedAt,
    lastReportedState: key ? key.split(":")[0]! : null,
  };
}
