import {
  controlMcpActionAllowed,
  controlMcpConfirmationRule,
  isApprovalResolution,
  type ControlMcpCredentialPolicy,
  type ControlMcpProfile,
} from "@orkestrator/protocol/control-mcp";
import {
  isPublicActionName,
  PUBLIC_ACTION_COMMAND,
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionName,
  type PublicActionResponse,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type { PublicNodeList } from "@orkestrator/protocol/public-api-resources";
import {
  classifyReceiptForWait,
  nextPublicWaitDelay,
  type PublicWaitVerdict,
} from "@orkestrator/protocol/public-api-wait";
import type { ConfirmTokens } from "./control-mcp-confirm.js";
import { adapterError, type ControlMcpEnvelope } from "./control-mcp-results.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import { withPublicAuthority } from "./public-api/dispatch.js";
import type { PublicAuthority } from "./public-api/operation-ledger.js";

/**
 * One authenticated operator request: who is calling, under which authority,
 * and the only way it reaches public actions.
 *
 * Every Control MCP mutation goes through `runPublicAction`: the credential
 * check, the request-key rule (required for mutations, refused for reads, as
 * `dispatchPublicAction` applies it), the confirmation rule, then exactly one
 * in-process `public_action` dispatch under the credential's authority. It
 * never reaches a raw registry command.
 */

export interface ControlMcpCaller {
  credential: ControlMcpCredentialPolicy & { label: string };
  profile: ControlMcpProfile;
  authority: PublicAuthority;
  /** Raw registry access on this node; every public action enters here. */
  invoke: ControlMcpInvoker;
  /**
   * Raw registry reads of the legacy operator tools on the targeted node
   * (`invoke_on_node`); omitted: `invoke`. Never used for public actions.
   */
  readInvoke?: ControlMcpInvoker;
  confirmTokens: ConfirmTokens;
  messagingEnabled: boolean;
  /**
   * The node every public action of this call runs on (`request.node`), a
   * nodeId from node.list or `all` for an aggregate read; omitted: this node.
   * Set per tool call with `onNode`.
   */
  nodeId?: string;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function allowed(caller: ControlMcpCaller, action: PublicActionName): boolean {
  return controlMcpActionAllowed(caller.credential, action);
}

/** The same caller, acting on one node (omitted or empty: this node). */
export function onNode(caller: ControlMcpCaller, nodeId: string | undefined): ControlMcpCaller {
  const { nodeId: _nodeId, readInvoke: _readInvoke, ...rest } = caller;
  return nodeId ? { ...rest, nodeId } : rest;
}

/** Confirmation is bound to the node too: a token for one node never runs on another. */
function confirmedInput(caller: ControlMcpCaller, input: Record<string, unknown>) {
  return caller.nodeId ? { input, nodeId: caller.nodeId } : input;
}

/** " on <node name>" for a confirmation naming another node, or "". */
async function nodeSuffix(caller: ControlMcpCaller): Promise<string> {
  if (!caller.nodeId) return "";
  const response = await caller.invoke<PublicActionResponse<PublicNodeList>>(
    PUBLIC_ACTION_COMMAND,
    withPublicAuthority(
      {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: "node.list",
        actionVersion: PUBLIC_ACTIONS["node.list"].version,
        input: {},
      },
      caller.authority,
    ),
  );
  const node = response.ok
    ? response.result.items.find((item) => item.nodeId === caller.nodeId)
    : undefined;
  if (node?.self) return "";
  return ` on ${node?.name ?? `node ${caller.nodeId}`}`;
}

/** One `public_action` dispatch under the caller's authority, with no checks of its own. */
export async function dispatchAs<T = unknown>(
  caller: ControlMcpCaller,
  action: PublicActionName,
  input: Record<string, unknown>,
  requestId?: string,
): Promise<PublicActionResponse<T>> {
  return caller.invoke<PublicActionResponse<T>>(
    PUBLIC_ACTION_COMMAND,
    withPublicAuthority(
      {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action,
        actionVersion: PUBLIC_ACTIONS[action].version,
        input,
        ...(requestId !== undefined ? { request: { requestId } } : {}),
        ...(caller.nodeId ? { node: caller.nodeId } : {}),
      },
      caller.authority,
    ),
  );
}

/** A composed read: the result, or null when the read is not allowed or failed. */
export async function readIfAllowed<T>(
  caller: ControlMcpCaller,
  action: PublicActionName,
  input: Record<string, unknown>,
): Promise<T | null> {
  if (!allowed(caller, action) || PUBLIC_ACTIONS[action].mutation) return null;
  const response = await dispatchAs<T>(caller, action, input);
  return response.ok ? response.result : null;
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

async function environmentName(caller: ControlMcpCaller, environmentId: unknown): Promise<string> {
  if (typeof environmentId !== "string") return "the environment";
  const environment = await readIfAllowed<{ name?: string }>(caller, "environment.get", {
    environmentId,
  });
  return environment?.name ? `environment ${environment.name}` : `environment ${environmentId}`;
}

/** The facts a confirmation names about an environment's pull request, as far as they can be read. */
interface PullRequestView {
  url?: string;
  number?: number;
  environment?: { cleanupAfterMergeRequested?: boolean };
  pullRequest?: {
    title: string;
    baseRef: string;
    headRef: string;
    isDraft: boolean;
    checksState: string;
    mergeability: string;
  } | null;
}

async function readPullRequest(
  caller: ControlMcpCaller,
  environmentId: unknown,
): Promise<PullRequestView | null> {
  if (typeof environmentId !== "string") return null;
  return readIfAllowed<PullRequestView>(caller, "pr.get", { environmentId });
}

/** `pull request #12 "Fix login" (fix-login into main)`, or its environment when unreadable. */
function pullRequestName(view: PullRequestView | null, fallback: string): string {
  const detail = view?.pullRequest;
  if (detail) {
    return `pull request #${view?.number} "${short(detail.title, 100)}" (${short(detail.headRef, 60)} into ${short(detail.baseRef, 60)})`;
  }
  return view?.number ? `pull request #${view.number}` : `the pull request of ${fallback}`;
}

/** What a merge is about to do and what stands against it, read out before it runs. */
async function mergeDescription(
  caller: ControlMcpCaller,
  input: Record<string, unknown>,
): Promise<string> {
  const environment = await environmentName(caller, input.environmentId);
  const view = await readPullRequest(caller, input.environmentId);
  const detail = view?.pullRequest;
  const warnings = [
    detail?.isDraft ? "it is a draft and is marked ready first" : null,
    detail?.checksState === "failure" ? "its checks are failing" : null,
    detail?.checksState === "pending" ? "its checks are still running" : null,
    detail?.mergeability === "dirty" ? "it has merge conflicts" : null,
    detail?.mergeability === "blocked" ? "a required review or check is unmet" : null,
    detail?.mergeability === "behind" ? "its branch is behind the base" : null,
  ].filter((warning) => warning !== null);
  const cleanup = input.cleanup === true || view?.environment?.cleanupAfterMergeRequested === true;
  const method = typeof input.method === "string" ? input.method : "squash";
  return [
    `This merges ${pullRequestName(view, environment)} with ${method}`,
    cleanup
      ? `, then deletes ${environment} and its worktree`
      : input.deleteBranch === false
        ? ""
        : " and deletes its branch",
    ". It cannot be undone.",
    warnings.length > 0 ? ` Note: ${warnings.join("; ")}.` : "",
  ].join("");
}

interface InteractionView {
  id: string;
  kind: string;
  title: string;
  body?: string;
}

async function findInteraction(
  caller: ControlMcpCaller,
  input: Record<string, unknown>,
): Promise<InteractionView | null> {
  if (typeof input.sessionId !== "string") return null;
  const response = await dispatchAs<{ items?: InteractionView[] }>(caller, "session.interactions", {
    sessionId: input.sessionId,
  });
  if (!response.ok) return null;
  return response.result.items?.find((item) => item.id === input.interactionId) ?? null;
}

/**
 * Whether this call needs a confirm token, and what to read aloud first. An
 * approval whose interaction cannot be read is confirmed: failing closed
 * costs one question, failing open would approve a command nobody heard.
 */
async function confirmationFor(
  caller: ControlMcpCaller,
  action: PublicActionName,
  input: Record<string, unknown>,
): Promise<string | null> {
  const rule = controlMcpConfirmationRule(action, caller.profile);
  if (rule === "none") return null;
  if (rule === "discard" && input.discard !== true) return null;
  if (action === "session.interaction.resolve") {
    if (input.action !== "answer" && input.action !== "approve-for-session") return null;
    const interaction = await findInteraction(caller, input);
    if (interaction && !isApprovalResolution(interaction.kind, input.action)) return null;
    const scope = input.action === "approve-for-session" ? " for the rest of the session" : "";
    if (!interaction)
      return `This approves a pending request${scope}; its details could not be read.`;
    const detail = interaction.body ? `: ${short(interaction.body, 160)}` : "";
    return `This approves ${short(interaction.title, 120)}${detail}${scope}.`;
  }
  switch (action) {
    case "environment.delete":
      return `This deletes ${await environmentName(caller, input.environmentId)} and its worktree.`;
    case "environment.recreate":
      return `This recreates ${await environmentName(caller, input.environmentId)} and discards its workspace changes.`;
    case "environment.stop":
      return `This stops ${await environmentName(caller, input.environmentId)} and every agent running in it.`;
    case "environment.exec": {
      const argv = Array.isArray(input.argv) ? input.argv.map(String).join(" ") : "a command";
      return `This runs \`${short(argv, 120)}\` in ${await environmentName(caller, input.environmentId)}.`;
    }
    case "pr.create":
      return `This starts an agent that commits, pushes and opens a pull request from ${await environmentName(caller, input.environmentId)}${typeof input.targetBranch === "string" ? ` against ${short(input.targetBranch, 100)}` : ""}.`;
    case "pr.resolve":
      return `This starts an agent that merges ${typeof input.targetBranch === "string" ? short(input.targetBranch, 100) : "the target branch"} into ${await environmentName(caller, input.environmentId)}, resolves conflicts and pushes.`;
    case "pr.merge":
      return mergeDescription(caller, input);
    case "pr.close":
      return `This closes ${pullRequestName(await readPullRequest(caller, input.environmentId), await environmentName(caller, input.environmentId))} without merging.`;
    case "pr.reopen":
      return `This reopens ${pullRequestName(await readPullRequest(caller, input.environmentId), await environmentName(caller, input.environmentId))}.`;
    case "pr.review": {
      const verdict =
        input.event === "APPROVE"
          ? "approves"
          : input.event === "REQUEST_CHANGES"
            ? "requests changes on"
            : "comments on";
      return `This ${verdict} ${pullRequestName(await readPullRequest(caller, input.environmentId), await environmentName(caller, input.environmentId))} as the configured GitHub user.`;
    }
    case "pr.comment":
      return `This posts a comment on the pull request of ${await environmentName(caller, input.environmentId)} as the configured GitHub user: ${short(String(input.body ?? ""), 160)}`;
    case "project.create":
      return `This creates a private GitHub repository at ${short(String(input.path ?? "a new path"), 200)} and pushes to it.`;
    case "project.remove":
      return `This removes project ${short(String(input.projectId ?? ""), 200)} from Orkestrator; no files or remotes are deleted.`;
    case "run.discard":
      return `This discards run ${String(input.operationId ?? "")}'s unconfirmed message; it may or may not have run.`;
    default:
      return `This runs ${action}: ${PUBLIC_ACTIONS[action].summary}`;
  }
}

/** "This deletes environment x and its worktree on Studio." */
function withNodeName(description: string, suffix: string): string {
  if (!suffix) return description;
  return description.endsWith(".")
    ? `${description.slice(0, -1)}${suffix}.`
    : `${description}${suffix}`;
}

/**
 * Run one public action for an MCP caller: the credential check, the
 * request-key rule, confirmation, then one dispatch.
 */
export async function runPublicAction(
  caller: ControlMcpCaller,
  rawAction: unknown,
  input: Record<string, unknown>,
  requestId: string | undefined,
  confirmToken: unknown,
): Promise<ControlMcpEnvelope> {
  const name = typeof rawAction === "string" ? rawAction.slice(0, 100) : "unknown";
  if (!isPublicActionName(rawAction)) {
    return adapterError(name, "unsupported", "Not a public action; find_actions lists them");
  }
  const action = rawAction;
  if (!allowed(caller, action)) {
    return adapterError(
      action,
      "capability-unavailable",
      `This credential may not call ${action}`,
      { capability: "credential" },
    );
  }
  const mutation = PUBLIC_ACTIONS[action].mutation;
  if (mutation && !requestId) {
    return adapterError(
      action,
      "invalid-input",
      "Mutations need a requestId; reuse it only to retry after an ambiguous response",
    );
  }
  if (!mutation && requestId !== undefined) {
    return adapterError(action, "invalid-input", "Read actions do not take a requestId");
  }
  const base = await confirmationFor(caller, action, input);
  const description = base ? withNodeName(base, await nodeSuffix(caller)) : null;
  if (description) {
    const bound = confirmedInput(caller, input);
    const check = caller.confirmTokens.check(
      confirmToken,
      caller.credential.id,
      action,
      bound,
      requestId,
    );
    if (check !== "valid") {
      const issued = caller.confirmTokens.issue(caller.credential.id, action, bound, requestId);
      const why =
        check === "missing"
          ? "Confirm before this runs."
          : check === "expired"
            ? "The confirmation expired; confirm again."
            : "The confirmation does not match this request; confirm this one.";
      return adapterError(action, "confirmation-required", `${why} ${description}`, {
        description,
        confirmToken: issued.token,
        expiresAt: issued.expiresAt,
        refused: check === "missing" ? undefined : check,
      });
    }
  }
  return dispatchAs(caller, action, input, mutation ? requestId : undefined);
}

export interface RunStatusOutcome {
  envelope: ControlMcpEnvelope;
  verdict: PublicWaitVerdict | null;
  waitedMs: number;
}

/**
 * Read a run through `run.get`, optionally waiting up to `waitSeconds` with
 * the CLI's backoff. Returns early on a terminal state, a pending
 * interaction, an unknown dispatch or outcome, or an unobservable provider.
 */
export async function runStatus(
  caller: ControlMcpCaller,
  query: Record<string, unknown>,
  waitSeconds: number,
): Promise<RunStatusOutcome> {
  const now = caller.now ?? Date.now;
  const sleep = caller.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const deadline = started + Math.max(0, Math.min(20, waitSeconds)) * 1_000;
  let delay: number | undefined;
  for (;;) {
    const envelope = await runPublicAction(caller, "run.get", query, undefined, undefined);
    const receipt: PublicReceipt | undefined = envelope.receipt;
    if (!envelope.ok || !receipt) return { envelope, verdict: null, waitedMs: now() - started };
    const verdict = classifyReceiptForWait(receipt);
    const remaining = deadline - now();
    if (verdict.kind !== "pending" || remaining <= 0) {
      return { envelope, verdict, waitedMs: now() - started };
    }
    delay = nextPublicWaitDelay(delay);
    await sleep(Math.min(delay, remaining));
  }
}
