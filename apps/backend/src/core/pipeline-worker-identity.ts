/**
 * Which build pipeline worker a backend-issued turn credential belongs to.
 *
 * A stage turn in tool mode connects with its workflow-result capability
 * alone, so that capability is also the worker's mail identity: the result
 * key names one attempt, and the pipeline record says which session (and so
 * which worker mailbox) that attempt belongs to. The answer comes from the
 * backend's own record, never from anything the agent supplies, so one
 * worker's credential can never act as another worker's mailbox.
 */
import { timingSafeEqual } from "node:crypto";
import { isRecord } from "./storage-shared.js";
import {
  isPipelineWorkerTabId,
  pipelineWorkerTabId,
} from "@orkestrator/protocol/pipeline-worker-mail";
import type { StorageService } from "./storage.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { ProviderWorkerMail } from "./agent-provider-contract.js";

/**
 * How one stage turn without a workflow-result capability carries its
 * worker's mail identity: a mailbox-scoped connection (bridge agents) or a
 * signed capability for an environment-wide connection (OpenCode).
 */
export interface PipelineWorkerMailTurn {
  agentMcp?: AgentToolConnection;
  workerMail?: ProviderWorkerMail;
}

type WorkerMailSigner = Pick<WorkflowResultService, "signWorkerMailCapability">;
type WorkerMailScope = { environmentId: string; projectId: string; tabId: string };

const WORKER_MAIL_CAPABILITY_PREFIX = "wm";
const MAX_WORKER_MAIL_CAPABILITY_BYTES = 2_048;

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,684}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return decoded && encodePart(decoded) === value ? decoded : null;
}

/**
 * A worker's mail capability, for a turn whose Orkestrator connection is
 * environment-wide and carries no workflow-result capability (OpenCode). It
 * names exactly one pipeline worker mailbox and is signed by the backend's
 * durable workflow-result identity, so it outlives a backend restart. It is
 * never a bearer credential: it only selects which mailbox an
 * already-authenticated environment connection's mail tools act as, and a
 * worker that has ended no longer has a mailbox to act as.
 */
export function pipelineWorkerMailCapability(
  signer: WorkerMailSigner,
  scope: WorkerMailScope,
): string {
  if (!isPipelineWorkerTabId(scope.tabId)) throw new Error("Not a pipeline worker mailbox");
  return [
    WORKER_MAIL_CAPABILITY_PREFIX,
    encodePart(scope.tabId),
    encodePart(scope.environmentId),
    encodePart(scope.projectId),
    signer.signWorkerMailCapability(scope, scope.tabId),
  ].join(".");
}

/** The worker mailbox a capability names, or null when it is not valid. */
export function authenticatePipelineWorkerMailCapability(
  signer: WorkerMailSigner,
  token: string,
): WorkerMailScope | null {
  if (Buffer.byteLength(token, "utf8") > MAX_WORKER_MAIL_CAPABILITY_BYTES) return null;
  const [prefix, tab, environment, project, signature, ...extra] = token.split(".");
  if (
    prefix !== WORKER_MAIL_CAPABILITY_PREFIX ||
    extra.length > 0 ||
    !tab ||
    !environment ||
    !project ||
    !signature ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    return null;
  const tabId = decodePart(tab);
  const environmentId = decodePart(environment);
  const projectId = decodePart(project);
  if (!tabId || !environmentId || !projectId || !isPipelineWorkerTabId(tabId)) return null;
  const scope = { environmentId, projectId, tabId };
  let expected: string;
  try {
    expected = signer.signWorkerMailCapability(scope, tabId);
  } catch {
    return null;
  }
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    return null;
  return scope;
}

/** The worker mailbox tab id the attempt `resultKey` belongs to, or null. */
export async function pipelineWorkerTabForResultKey(
  storage: Pick<StorageService, "listBuildPipelinesForEnvironment">,
  scope: { environmentId: string; projectId: string },
  resultKey: string,
): Promise<string | null> {
  const records = await storage.listBuildPipelinesForEnvironment(
    scope.projectId,
    scope.environmentId,
  );
  for (const record of records) {
    const snapshot = record.snapshot;
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) continue;
    const sessions = snapshot.sessions.filter(isRecord);
    const bySessionId = (sessionId: unknown) =>
      sessions.find((session) => session.sdkSessionId === sessionId);
    const owner =
      sessions.find((session) => session.structuredRequestId === resultKey) ??
      (isRecord(snapshot.pendingPromptAttempt) &&
      snapshot.pendingPromptAttempt.requestId === resultKey
        ? bySessionId(snapshot.pendingPromptAttempt.sessionId)
        : undefined) ??
      (isRecord(snapshot.activePromptContext) &&
      snapshot.activePromptContext.requestId === resultKey
        ? bySessionId(snapshot.activePromptContext.sessionId)
        : undefined);
    if (owner && typeof owner.sessionKey === "string") return pipelineWorkerTabId(owner.sessionKey);
    const fanout = isRecord(snapshot.reviewFanout) ? snapshot.reviewFanout : undefined;
    const reviewers = Array.isArray(fanout?.reviewers) ? fanout.reviewers.filter(isRecord) : [];
    const reviewer = reviewers.find((candidate) => candidate.requestId === resultKey);
    if (reviewer && typeof reviewer.sessionKey === "string")
      return pipelineWorkerTabId(reviewer.sessionKey);
    const consolidation = isRecord(fanout?.consolidation) ? fanout.consolidation : undefined;
    if (consolidation?.requestId === resultKey && typeof consolidation.sessionKey === "string")
      return pipelineWorkerTabId(consolidation.sessionKey);
  }
  return null;
}
