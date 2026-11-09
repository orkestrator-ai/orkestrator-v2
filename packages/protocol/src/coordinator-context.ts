import { COORDINATOR_ACTION_GUIDANCE } from "./coordinator-actions.js";
/**
 * The context block at the head of every coordinator prompt.
 *
 * Pure: the caller does every read (repository config, checkout update, node
 * role, scheduling, open work) and passes the answers in, so the block's
 * content and size can be checked without a running service. The rules
 * themselves live in `coordinator.ts`, because tool results and the Control MCP
 * instructions repeat some of them verbatim.
 *
 * Lines that change turn to turn stay at the end of the block, so a provider's
 * prompt cache keeps the stable part in front of them.
 */
import { COORDINATOR_AGENTS_MD_RULE } from "./agents-md-orkestrator.js";
import {
  COORDINATOR_REQUEST_ID_RULE,
  COORDINATOR_ASYNC_CONTRACT,
  COORDINATOR_CONTEXT_CLOSE_TAG,
  COORDINATOR_CONTEXT_OPEN_TAG,
  COORDINATOR_ENVIRONMENT_CHOICE_RULE,
  COORDINATOR_LAUNCH_DEFAULTS_RULE,
  COORDINATOR_MAIL_ADDRESS,
  COORDINATOR_MESSAGING_OFF_NOTE,
  COORDINATOR_PR_RULE,
  COORDINATOR_ROUTING_RULE,
  COORDINATOR_TIMERS_AND_ACCOUNTS_RULE,
  COORDINATOR_VALIDATION_RULE,
  COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
  coordinatorDelegationBucket,
  type CoordinatorWorkflowAssociation,
} from "./coordinator.js";

/** How many worker names the "Waiting on" line spells out; the rest are a count. */
export const COORDINATOR_WAITING_ON_NAMES = 3;

const MAX_LABEL_LENGTH = 60;
const MAX_PATH_LENGTH = 300;

/**
 * Text from outside the backend inside the context block (commit subjects,
 * paths, project and worker names): keep it on one line, and never let it close
 * the block.
 */
export function inlineCoordinatorContextText(value: string): string {
  return value.replace(/\s+/g, " ").replaceAll("<", "‹").trim();
}

function bounded(value: string, length: number): string {
  const text = inlineCoordinatorContextText(value);
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

/** One worker a coordinator has an open delegation on. */
export interface CoordinatorOpenWorker {
  resourceId: string;
  nodeId?: string;
  /** The name recorded on the association, when it has one. */
  recordedName?: string;
}

/**
 * The workers this coordinator is waiting on, newest request first. An
 * association is one request, so a worker asked twice appears once.
 */
export function coordinatorOpenWorkers(
  associations: readonly CoordinatorWorkflowAssociation[],
  coordinatorId: string,
): CoordinatorOpenWorker[] {
  const open = associations
    .filter(
      (association) =>
        association.coordinatorId === coordinatorId &&
        association.delegation !== undefined &&
        coordinatorDelegationBucket(association.delegation) !== "finished",
    )
    .sort((a, b) => b.delegation!.requestedAt.localeCompare(a.delegation!.requestedAt));
  const seen = new Set<string>();
  const workers: CoordinatorOpenWorker[] = [];
  for (const association of open) {
    const key = `${association.nodeId ?? ""}\u0000${association.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    workers.push({
      resourceId: association.resourceId,
      ...(association.nodeId ? { nodeId: association.nodeId } : {}),
      ...(association.workerOutcome?.name ? { recordedName: association.workerOutcome.name } : {}),
    });
  }
  return workers;
}

/** The open work one main coordinator is told about. */
export interface CoordinatorWaitingOn {
  /** The first {@link COORDINATOR_WAITING_ON_NAMES} are spelled out. */
  names: readonly string[];
  /** Every open worker, named or not. */
  total: number;
}

function waitingOnLine(waitingOn: CoordinatorWaitingOn | null | undefined): string {
  if (!waitingOn || waitingOn.total <= 0) return "";
  const names = waitingOn.names
    .slice(0, COORDINATOR_WAITING_ON_NAMES)
    .map((name) => JSON.stringify(bounded(name, MAX_LABEL_LENGTH)));
  const rest = waitingOn.total - names.length;
  const listed =
    names.join(", ") + (rest > 0 ? `${names.length > 0 ? " and " : ""}${rest} more` : "");
  return `Waiting on ${waitingOn.total} ${waitingOn.total === 1 ? "worker" : "workers"}: ${listed}. list_workflows with openOnly shows each one's state.\n`;
}

/** The delegation part of the block; a conversation is exactly one of these. */
export type CoordinatorContextDelegation =
  /** A side agent: it reads and mails the main coordinator, and launches nothing. */
  | { kind: "side"; title: string; messagingEnabled: boolean }
  /** The main coordinator, with worker controls and a way to be woken. */
  | {
      kind: "main";
      /** The base branch whose latest commit workers start from. */
      baseBranch: string;
      schedulingEnabled: boolean;
      waitingOn?: CoordinatorWaitingOn | null;
    }
  /** The main coordinator without worker controls, or with no way to be woken. */
  | { kind: "unavailable"; messagingEnabled: boolean };

export interface CoordinatorContextInput {
  project: { id: string; name?: string | null; checkoutPath?: string | null };
  coordinatorId: string;
  repository: {
    contextRevision: number;
    branch?: string | null;
    headCommit?: string | null;
  };
  /** Already rendered, ending in a newline or empty. */
  researchLine: string;
  /** Already rendered, ending in a newline or empty. */
  nodeLine: string;
  /** Already rendered, ending in a newline or empty. */
  checkoutUpdate: string;
  delegation: CoordinatorContextDelegation;
}

function projectLine(project: CoordinatorContextInput["project"]): string {
  const name = project.name?.trim() ? bounded(project.name, MAX_LABEL_LENGTH) : "";
  const path = project.checkoutPath?.trim() ? bounded(project.checkoutPath, MAX_PATH_LENGTH) : "";
  if (!name && !path) return `Project: ${project.id}\n`;
  return `Project: ${name || "unnamed"}${path ? ` at ${path}` : ""} (id ${project.id})\n`;
}

function delegationLines(delegation: CoordinatorContextDelegation): string {
  if (delegation.kind === "side") {
    return (
      `Side agent: you are ${bounded(delegation.title, MAX_LABEL_LENGTH)}, a side agent of this project's coordinator. You can read the project and Orkestrator state, including a worker's changes with get_worker_changes, but you cannot launch environments or jobs. ` +
      (delegation.messagingEnabled
        ? `Exchange mail only with the main coordinator: send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}". Workers and other agents cannot reach you.\n`
        : `Agent messaging is off, so you cannot exchange mail with anyone until the user turns it on in Settings.\n`)
    );
  }
  if (delegation.kind === "unavailable") {
    return (
      `Delegation: Orkestrator worker controls are unavailable in this session. Provider sub-agents remain inside this coordinator session and are not worker environments; do not report them as workers.\n` +
      (delegation.messagingEnabled ? "" : `${COORDINATOR_MESSAGING_OFF_NOTE}\n`)
    );
  }
  return (
    `Main coordinator: every worker in this project reports to you. Side agents (Side 1, Side 2…) may mail you; reach one with send_message to its environment id from list_mailboxes. Message a worker by its environment id; toTabId is optional.\n` +
    `Delegation: create workers with the Orkestrator launch_environment tool. Provider sub-agents remain inside this coordinator session and are not worker environments. Report a worker as created only after launch_environment returns its environment id.\n` +
    `${COORDINATOR_ACTION_GUIDANCE}\n` +
    `${COORDINATOR_ROUTING_RULE}\n` +
    `${COORDINATOR_ENVIRONMENT_CHOICE_RULE}\n` +
    `Actions: launch_multi_review runs the environment's Multi Review button action; open_multi_review and open_multi_review_fix present saved work. ${COORDINATOR_REQUEST_ID_RULE} Inspect outcome, ui and recovery before reporting completion.\n` +
    `Workers: check a worker's work with get_worker_changes (its commits, changed files, uncommitted files and diff, local or container), not only its report. To try an alternative from where a worker got to, fork_worker starts a new worker from its last commit.\n` +
    // Workers start where a normal environment would: the latest commit of the
    // configured base branch, not wherever this checkout happens to be.
    `Launch base: every launch_environment call must include baseBranch and baseCommit. By default start workers from the latest commit of the base branch ${bounded(delegation.baseBranch, MAX_PATH_LENGTH)}: call get_launch_options and pass coordinatorBase.baseBranch and coordinatorBase.baseCommit unchanged. ` +
    `Use checkoutBase, the branch and commit of this checkout shown below, only when the user asks to build on the current checkout. If coordinatorBase is unavailable, report that instead of guessing values.\n` +
    `${COORDINATOR_WORKER_PROMPT_FORMAT_RULE}\n` +
    `${COORDINATOR_LAUNCH_DEFAULTS_RULE}\n` +
    `${COORDINATOR_PR_RULE}\n` +
    `${COORDINATOR_VALIDATION_RULE}\n` +
    `${COORDINATOR_AGENTS_MD_RULE}\n` +
    (delegation.schedulingEnabled ? `${COORDINATOR_TIMERS_AND_ACCOUNTS_RULE}\n` : "") +
    `${COORDINATOR_ASYNC_CONTRACT}\n`
  );
}

/** The whole context block, tags included, with no trailing newline. */
export function buildCoordinatorContext(input: CoordinatorContextInput): string {
  return (
    `${COORDINATOR_CONTEXT_OPEN_TAG}\n` +
    projectLine(input.project) +
    `Coordinator: ${input.coordinatorId}\n` +
    `Role: read-only coordinator. You get the project's work done: research and plan here, then have workers make every file change, checkout-mutating command, build and fix in isolated environments through approved Orkestrator controls. Never attempt to alter the project checkout directly.\n` +
    `Scope: keep your own work to quick reads, searches and lookups. Anything more serious (a multi-file investigation, running builds or tests, reproducing a bug, writing or reviewing code in depth) belongs in a worker environment you launch, even when it only reads.\n` +
    input.researchLine +
    input.nodeLine +
    `Tools: report a tool as unavailable or denied only after you called it and the call was refused; never assume a refusal you have not seen.\n` +
    delegationLines(input.delegation) +
    `Repository context revision: ${input.repository.contextRevision}\n` +
    `Branch: ${inlineCoordinatorContextText(input.repository.branch ?? "unknown")}\n` +
    `Commit: ${input.repository.headCommit ?? "unknown"}\n` +
    input.checkoutUpdate +
    (input.delegation.kind === "main" ? waitingOnLine(input.delegation.waitingOn) : "") +
    COORDINATOR_CONTEXT_CLOSE_TAG
  );
}
