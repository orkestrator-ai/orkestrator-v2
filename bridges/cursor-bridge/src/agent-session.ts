/**
 * Session lifecycle: creating, attaching, resuming and closing an SDK agent.
 *
 * A session is durable; the agent object that serves it is not. The bridge
 * keeps the transcript, the prompt journal and the composer selection, and
 * attaches an SDK agent lazily around them. That split is what lets a bridge
 * restart, an idle detach or a crashed child all recover without the renderer
 * seeing anything other than a session that was briefly connecting.
 */
import { stripSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentPolicyDeniesWebSearch,
} from "@orkestrator/protocol/native-agent";
import { cursorAppliedPolicy, resolveCursorExecutionPolicy } from "./execution-policy.js";

export { cursorAppliedPolicy, resolveCursorExecutionPolicy };
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type AgentOptions,
  type LocalAgentRunDocument,
  type SDKAgent,
  type SDKAgentInfo,
  type ToolName,
} from "@cursor/sdk";
import { MAX_RESUME_ENTRIES, workingDirectory } from "./config.js";
import { CURSOR_AUTHENTICATION_REQUIRED_MESSAGE, resolveCredential } from "./credentials.js";
import { schedulePersist } from "./persistence.js";
import {
  cancelSurvivingRuns,
  cursorAgentApi,
  listAllRuns,
  SessionConflictError,
  useCursorAgentForTests,
} from "./cursor-runs.js";
import { newSessionState } from "./session-factory.js";
import { finishTombstonesForAgent, hasTombstoneForAgent } from "./session-tombstones.js";

export { cancelSurvivingRuns, newSessionState, SessionConflictError, useCursorAgentForTests };
import { schedulePlanAccountRefresh } from "./plan-usage.js";
import { hydrateComposer, modelSelection } from "./models.js";
import { renderToolCall } from "./tool-rendering.js";
import { COORDINATOR_SKILLS_SERVER, hostSkillCustomTools } from "./coordinator-skills.js";
import {
  cursorMcpServers,
  cursorInlineMcpServers,
  cursorSettingSources,
  cursorUserMcpServerFilter,
  hostOrkestratorCustomTools,
  hostResearchCustomTools,
  mcpConnectionKey,
  retireMcpObservations,
  type AgentMcpConnection,
} from "./mcp.js";
import {
  cursorLocalAgentStore,
  hasUnusedInitialRun,
  prewarmCursorWorkspace,
} from "./sdk-runtime.js";
import {
  beginAssistantTurn,
  boundTranscript,
  boundTranscriptDuringStreaming,
  chargeTranscript,
  rewindTranscriptTo,
  startTranscriptEpoch,
} from "./transcript.js";
import { applyInteractionUpdate } from "./translate.js";
import { trackTurnEvidence, type TurnEvidence } from "./change-evidence.js";
import {
  assertSessionOpen,
  clientSessionKeys,
  isObject,
  nonBlank,
  SessionClosedError,
  sessionCreations,
  sessions,
  type BridgeMessage,
  type BridgeMessagePart,
  type JsonObject,
  type SessionState,
} from "./state.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.cursor");

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/**
 * Create a session, or return the one this client key already owns.
 *
 * Idempotent by `clientSessionKey` because the backend retries session
 * creation through a short bridge-startup race: without this, a retry that
 * lands after the first call succeeded would leave the user with two agents
 * and a tab pointed at only one of them.
 */
export async function createSession(
  clientSessionKey: string | undefined,
  patch: ComposerPatch | undefined,
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
  readOnly?: boolean,
): Promise<SessionState> {
  if (clientSessionKey) {
    const existingId = clientSessionKeys.get(clientSessionKey);
    const existing = existingId ? sessions.get(existingId) : undefined;
    if (existing) {
      // A closing session is never handed back: the caller would be given an
      // id whose close is already in flight. Once the close settles the key
      // is released and a deliberate create gets a new session.
      if (existing.closed) {
        throw new SessionConflictError(
          "This Cursor session is closing; retry once the close completes",
        );
      }
      if (policy) existing.policy = resolveCursorExecutionPolicy(policy);
      // The boundary of a session that already exists is moved by the caller
      // of this function, which owns the HTTP status a conflicting move
      // deserves. `readOnly` here only seeds a session being created.
      return existing;
    }
    const inFlight = sessionCreations.get(clientSessionKey);
    if (inFlight) return inFlight;
  }

  const work = (async () => {
    const state = newSessionState(clientSessionKey, resolveCursorExecutionPolicy(policy));
    // The only session whose journal starts complete: it has no agent id, so
    // its first attach creates a new SDK agent that nothing but this journal
    // has ever sent to. Resume and restore never set this here.
    state.promptJournalComplete = true;
    if (typeof readOnly === "boolean") state.readOnly = readOnly;
    applyComposerPatch(state, patch);
    state.composer = await hydrateComposer(state.composer);
    sessions.set(state.id, state);
    if (clientSessionKey) clientSessionKeys.set(clientSessionKey, state.id);
    return state;
  })();

  if (!clientSessionKey) return work;
  sessionCreations.set(clientSessionKey, work);
  try {
    return await work;
  } finally {
    sessionCreations.delete(clientSessionKey);
  }
}

/**
 * Attach an SDK agent to this session, reusing an in-flight attach.
 *
 * Without the shared promise this is a check-then-act race: the function reads
 * `state.agent`, then awaits a create, so two concurrent callers each see null
 * and each start an agent. Attach is reachable from the prompt route, the
 * config route and the explicit attach route, so that race is ordinary
 * concurrency rather than a corner case.
 */
export async function ensureAgent(
  state: SessionState,
  options: { atTurnStart?: boolean; requireCurrentModel?: boolean } = {},
): Promise<SDKAgent> {
  // A closing session attaches nothing. Checked here rather than at each
  // route so no future caller can forget it.
  assertSessionOpen(state);
  if (state.agent && (state.attachedMcpKey ?? "") !== mcpConnectionKey(state.agentMcp)) {
    // A rotated tab token detaches whatever the turn state. If the saved MCP
    // files also changed, this detach is adopting a configuration change too,
    // and a failed resume must not quietly become a new conversation — the
    // branch below never sees it, because the agent is already gone.
    const agent = state.agent;
    const attached = attachedConfigKeys.get(state);
    const configChanged =
      attached !== undefined && attached !== (await cursorMcpConfigFingerprint(state));
    // The fingerprint read yields. Only a caller that still sees the agent it
    // read, still on the old credential, owns this detach.
    if (
      state.agent === agent &&
      (state.attachedMcpKey ?? "") !== mcpConnectionKey(state.agentMcp)
    ) {
      if (configChanged) {
        markConfigResumePending(state, true);
        retireMcpObservations(state);
      }
      await detachAgent(state);
    }
  }
  // A saved MCP configuration change is adopted only between turns: the SDK
  // reads settings sources when an agent is created or resumed, so the live
  // agent is released and resumed on the same conversation. The prompt path
  // has already claimed `dispatching` for the turn it is starting.
  const idle = state.status !== "running" && (options.atTurnStart || !state.dispatching);
  const agent = state.agent;
  if (agent && !state.attaching && idle) {
    const attached = attachedConfigKeys.get(state);
    // The fingerprint read yields. A concurrent caller may have detached this
    // agent and started the replacement attach meanwhile; detaching again
    // would tear down the agent that attach is about to publish. Only a caller
    // that still sees the agent it read, with no attach in flight, owns it.
    if (
      attached !== undefined &&
      attached !== (await cursorMcpConfigFingerprint(state)) &&
      state.agent === agent &&
      !state.attaching &&
      (options.atTurnStart || (state.status !== "running" && !state.dispatching))
    ) {
      markConfigResumePending(state, true);
      retireMcpObservations(state);
      await detachAgent(state);
    }
  }
  // summarize() has no model override and SDKAgent.model is read-only. Resume
  // the same saved conversation with the current selection before compaction.
  if (
    options.requireCurrentModel &&
    state.agent &&
    JSON.stringify(state.agent.model) !== JSON.stringify(modelSelection(state.composer))
  ) {
    markConfigResumePending(state, true);
    await detachAgent(state);
  }
  assertSessionOpen(state);
  if (state.agent) return state.agent;
  state.attaching ??= attach(state).finally(() => {
    state.attaching = undefined;
  });
  return state.attaching;
}

/**
 * Cursor's names for denied cross-provider capabilities.
 *
 * The policy's `toolPolicy.deny` carries Codex's vocabulary, so it is never
 * forwarded: unknown names make Agent.create/resume reject the whole session.
 */
const CURSOR_CAPABILITY_TOOLS: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  "file.write": ["edit", "delete", "applyAgentDiff", "task"],
  "file.patch": ["edit", "applyAgentDiff", "task"],
  shell: ["shell", "task"],
  "shell.mutate": ["shell", "task"],
  network: ["webFetch", "webSearch", "task"],
  // Its sub-agent tool; a read-only attach never offers it at all.
  subagents: ["task"],
});

/**
 * Built-ins that cannot mutate the checkout, launch an independently tooled
 * subagent, or access the network. An allowlist is deliberate: a new Cursor
 * writing tool stays unavailable until reviewed.
 *
 * `mcp` has to be in here explicitly. The SDK treats it as a capability group
 * for the whole MCP family (including in-process `customTools`); omitting it
 * disables every server, including the Orkestrator control tools a
 * coordinator exists to call. HTTP MCP stays unloaded on read-only attaches
 * (`settingSources: []`); those tools are hosted in-process because the
 * sandbox approval path fails closed without a callback.
 */
export const CURSOR_READ_ONLY_TOOLS = [
  "read",
  "grep",
  "glob",
  "ls",
  "readLints",
  "semSearch",
  "readTodos",
  "askQuestion",
  "await",
  "mcp",
] as const satisfies readonly ToolName[];

const CURSOR_TOOL_ALIASES: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  ls: ["ls"],
  shell: ["shell"],
  bash: ["shell"],
  edit: ["edit"],
  write: ["edit"],
  apply_patch: ["applyAgentDiff"],
});

export function cursorDeniedTools(
  policy: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): ToolName[] {
  const tools = new Set<ToolName>();
  // Either wire form: denials newer than the legacy six travel in `extendedDeny`.
  for (const capability of nativeAgentDeniedCapabilities(policy)) {
    for (const tool of CURSOR_CAPABILITY_TOOLS[capability] ?? []) tools.add(tool);
  }
  return Array.from(tools);
}

function cursorAllowedTools(
  policy: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): ToolName[] | undefined {
  if (!policy.toolPolicy?.allow) return undefined;
  const tools = new Set<ToolName>();
  for (const name of policy.toolPolicy.allow) {
    for (const tool of CURSOR_TOOL_ALIASES[name] ?? []) tools.add(tool);
  }
  return Array.from(tools);
}

let configHomeForTests: string | undefined;

/** Point the configuration fingerprint at a temporary home; never the operator's. */
export function setCursorMcpConfigHomeForTests(home?: string): void {
  configHomeForTests = home;
}

let skillsProjectForTests: string | undefined;

/** Point coordinator skill discovery at a temporary project; never the checkout's own skills. */
export function setCursorSkillsProjectForTests(directory?: string): void {
  skillsProjectForTests = directory;
}

/** Fingerprints of the MCP files each attached agent was created from. */
const attachedConfigKeys = new WeakMap<SessionState, string>();
/** The per-file digests behind each attached agent's fingerprint, and when they were read. */
const attachedConfigRevisions = new WeakMap<
  SessionState,
  CursorMcpConfigRevision & { builtAt: string }
>();
let fingerprintForTests: ((state: SessionState) => Promise<string>) | undefined;

export function setCursorMcpFingerprintForTests(
  fingerprint?: (state: SessionState) => Promise<string>,
): void {
  fingerprintForTests = fingerprint;
}
/**
 * Record that a session was detached to adopt a configuration change. Its next
 * attach must resume the same conversation: silently starting a new one to
 * apply a settings edit would drop the model's context without the user
 * choosing it. Persisted with the session, so a bridge restart between the
 * detach and a successful resume cannot turn the next failed resume into a
 * fresh conversation.
 */
function markConfigResumePending(state: SessionState, pending: boolean): void {
  if ((state.configResumePending === true) === pending) return;
  if (pending) state.configResumePending = true;
  else delete state.configResumePending;
  schedulePersist();
}

/**
 * Content-free identity of the MCP files an agent was created from.
 *
 * Each source is `sha256:<base64url>` of the file's exact bytes, `absent`, or
 * `excluded` when the session's policy does not load it — so the backend,
 * which knows what it wrote, can tell whether an attached agent picked a save
 * up. Never a path and never a server body: the files hold headers and env.
 */
export interface CursorMcpConfigRevision {
  /** One opaque value over both sources; `read-only` for a coordinator. */
  fingerprint: string;
  sources: {
    /** `~/.cursor/mcp.json`. */
    user: string;
    /** `<cwd>/.cursor/mcp.json`. */
    project: string;
  };
}

async function fileDigest(file: string): Promise<string> {
  try {
    return `sha256:${createHash("sha256")
      .update(await readFile(file))
      .digest("base64url")}`;
  } catch {
    return "absent";
  }
}

/**
 * Per-file digests of the MCP files a session's settings sources read.
 * Read-only coordinators load no settings sources, so their configuration
 * never changes and both sources are `excluded`.
 */
export async function cursorMcpConfigRevision(
  state: SessionState,
): Promise<CursorMcpConfigRevision> {
  const policy = resolveCursorExecutionPolicy(state.readOnly ? undefined : state.policy);
  if (state.readOnly || policy.id === "coordinator-read-only") {
    return { fingerprint: "read-only", sources: { user: "excluded", project: "excluded" } };
  }
  const [user, project] = await Promise.all([
    fileDigest(join(configHomeForTests ?? homedir(), ".cursor", "mcp.json")),
    policy.projectResources
      ? fileDigest(join(workingDirectory, ".cursor", "mcp.json"))
      : Promise.resolve("excluded"),
  ]);
  return {
    fingerprint: createHash("sha256")
      .update(`user=${user}\u0000project=${project}`)
      .digest("base64url"),
    sources: { user, project },
  };
}

/** Fingerprint of the MCP files a session's settings sources read. */
export async function cursorMcpConfigFingerprint(state: SessionState): Promise<string> {
  if (fingerprintForTests) return fingerprintForTests(state);
  return (await cursorMcpConfigRevision(state)).fingerprint;
}

/**
 * Which saved MCP configuration the attached agent was created from, for
 * `/session/:id/runtime-health`. Absent while no agent is attached: a
 * detached session has loaded nothing, which is how the backend tells "not
 * yet applied" from "applied". Content-free digests only.
 */
export function publicCursorMcpConfig(
  state: SessionState,
): (CursorMcpConfigRevision & { builtAt: string }) | undefined {
  if (!state.agent) return undefined;
  const revision = attachedConfigRevisions.get(state);
  return revision ? structuredClone(revision) : undefined;
}

async function attach(state: SessionState): Promise<SDKAgent> {
  // Fingerprint before reading any configuration, so an edit racing this
  // attach is seen as a change at the next boundary rather than missed.
  // `builtAt` is taken before the read too: a lower bound on when the bytes
  // behind the reported digests were read.
  const builtAt = new Date().toISOString();
  const revision = fingerprintForTests ? undefined : await cursorMcpConfigRevision(state);
  const configKey = revision?.fingerprint ?? (await cursorMcpConfigFingerprint(state));
  const recordAttachedConfig = () => {
    attachedConfigKeys.set(state, configKey);
    if (revision) attachedConfigRevisions.set(state, { ...revision, builtAt });
    else attachedConfigRevisions.delete(state);
  };
  const policy = cursorAppliedPolicy(state);
  const readOnly = policy.id === "coordinator-read-only";
  if (policy.approvals === "deny" && !readOnly) {
    throw new Error(
      "Cursor SDK cannot enforce an approvals-deny policy, so this session was refused before attach.",
    );
  }
  // A read-only coordinator is the one deny case Cursor can express: a process
  // boundary plus a closed tool allowlist, with no approval callback behind
  // them. The boundary may be Cursor's sandbox or the outer container.
  // Orkestrator reports this as `provider-configured` rather than enforced.
  if (readOnly && policy.sandbox !== "provider" && policy.sandbox !== "container") {
    throw new Error(
      "Cursor cannot run a read-only coordinator without a sandbox boundary, so this session was refused before attach.",
    );
  }
  const { apiKey } = await resolveCredential();
  if (!apiKey) {
    throw new CredentialError(CURSOR_AUTHENTICATION_REQUIRED_MESSAGE);
  }
  // A graph node loads only the user servers it was granted (item 404). Read-
  // only attaches already load nothing but Orkestrator's own entries.
  const selectServers = readOnly ? undefined : cursorUserMcpServerFilter(policy);
  const mcpServers = await cursorMcpServers(state.agentMcp, {
    readOnly,
    projectResources: policy.projectResources,
    ...(selectServers
      ? { userServers: selectServers, configHome: configHomeForTests ?? homedir() }
      : {}),
  });
  // A provider-sandbox coordinator cannot call HTTP MCP: the SDK's approval
  // path fails closed with no callback. Host those tools in-process instead.
  // If hosting fails, omit HTTP mcpServers on that attach — the model would
  // otherwise see tools that fail closed. Container attaches disable the
  // provider sandbox, so they may still take the vendor HTTP client.
  const allowHttpMcp = !readOnly || policy.sandbox === "container";
  const [hosted, research] = readOnly
    ? await Promise.all([
        hostOrkestratorCustomTools(state.agentMcp, state.health, {
          httpFallback: policy.sandbox === "container",
          workflowResultTurn: () => state.workflowResultTurn,
        }),
        // The launcher's research servers, hosted the same way: a sandboxed
        // read-only attach cannot call an HTTP MCP server either.
        hostResearchCustomTools(state.health),
      ])
    : [undefined, undefined];
  const closeHosted =
    hosted || research
      ? async () => {
          await Promise.allSettled([hosted?.close(), research?.close()]);
        }
      : undefined;
  if (state.closed) {
    await closeHosted?.();
    throw new SessionClosedError();
  }
  // The user's and the project's skills, served by a read-only tool of the
  // bridge's own: the SDK cannot load skills without a whole settings layer.
  const skills = readOnly
    ? hostSkillCustomTools(process.env, skillsProjectForTests ?? workingDirectory)
    : undefined;
  const customTools =
    hosted || research || skills
      ? { ...skills?.customTools, ...research?.customTools, ...hosted?.customTools }
      : undefined;
  const httpMcpServerNames = hosted ? [] : allowHttpMcp ? Object.keys(mcpServers) : [];
  state.hostedMcpClose = closeHosted;
  state.hostedMcpTools = customTools;
  state.researchMcpServerNames = research?.serverNames;
  state.mcpServerNames = [
    ...(hosted ? ["orkestrator"] : httpMcpServerNames),
    ...(research?.serverNames ?? []),
    ...(skills ? [COORDINATOR_SKILLS_SERVER] : []),
  ];
  state.attachedMcpKey = mcpConnectionKey(state.agentMcp);
  const settingSources = cursorSettingSources(policy, {
    readOnly,
    selectsServers: selectServers !== undefined,
  });
  // Without `project` the SDK skips AGENTS.md; `cursorPromptText` sends it.
  state.loadsProjectRules = settingSources.includes("project");
  const options: AgentOptions = {
    apiKey,
    model: modelSelection(state.composer),
    mode: state.composer.selectedModeId === "plan" ? ("plan" as const) : ("agent" as const),
    local: {
      cwd: workingDirectory,
      // Read-only coordinators keep only the injected Orkestrator MCP server.
      // User settings would otherwise load the host's MCP catalog through the
      // same `mcp` capability the allowlist has to grant for delegation.
      settingSources,
      sandboxOptions: { enabled: policy.sandbox === "provider" },
      autoReview: policy.sandbox === "provider" && policy.approvals === "auto-approve",
      ...(customTools ? { customTools } : {}),
    },
    ...(readOnly
      ? {
          // Hosted search joins the closed allowlist only when the policy's
          // `allow` names it; `webFetch` never does.
          tools: [
            ...CURSOR_READ_ONLY_TOOLS,
            ...(nativeAgentPolicyDeniesWebSearch(policy) ? [] : (["webSearch"] as const)),
          ],
        }
      : (() => {
          const allowed = cursorAllowedTools(policy);
          return allowed ? { tools: allowed } : {};
        })()),
    ...(!readOnly
      ? (() => {
          const denied = cursorDeniedTools(policy);
          return denied.length > 0 ? { disallowedTools: denied } : {};
        })()
      : {}),
    ...(httpMcpServerNames.length > 0
      ? {
          mcpServers: cursorInlineMcpServers(
            mcpServers,
            !readOnly && policy.projectResources && !selectServers,
          ),
        }
      : {}),
  };
  const releaseWarmWorkspace = await prewarmCursorWorkspace(options, policy.sandbox);
  state.workspaceWarmRelease = releaseWarmWorkspace;
  state.agentLocalOptions = options.local;

  try {
    // Closed while the workspace warmed: nothing may be created for it.
    assertSessionOpen(state);
    // A session that already ran holds an agent id, and resuming it is what
    // keeps the model's own context across a bridge restart. A resume that fails
    // is not fatal: the id may name an agent the store no longer has, and a new
    // agent with the transcript we already hold is a far better outcome than a
    // tab that can never send again.
    // A warm-up detached before its first send has no conversation to resume.
    // Keep its store record intact, but create a usable first-run handle under
    // the current policy. This also repairs placeholders restored after exit.
    if (state.agentId && !(await hasUnusedInitialRun(state.agentId))) {
      // A close a previous process left unfinished for this same conversation
      // cancels every run it finds; it has to finish before this attach can
      // start one. Its failure refuses the attach — it is not a reason to
      // abandon the conversation for a new one.
      if (hasTombstoneForAgent(state.agentId)) {
        await finishTombstonesForAgent(state.agentId);
        assertSessionOpen(state);
      }
      try {
        const resumed = await cursorAgentApi().resume(state.agentId, options);
        await disposeIfClosed(state, resumed);
        state.agent = resumed;
        recordAttachedConfig();
        markConfigResumePending(state, false);
        schedulePlanAccountRefresh();
        return resumed;
      } catch (error) {
        if (error instanceof SessionClosedError) throw error;
        if (state.configResumePending) {
          throw new Error(
            "Cursor could not reopen this conversation with the updated configuration. The conversation was kept; retry with the current settings.",
            { cause: error },
          );
        }
        state.agentId = undefined;
      }
    }

    const created = await cursorAgentApi().create({ ...options, name: "Orkestrator" });
    await disposeIfClosed(state, created);
    // `getUsage()` is scoped to one SDK agent. If resume failed (or a restored
    // state somehow lost its id), the replacement starts its cumulative token
    // and cost counters from zero; retaining the previous agent's floor would
    // reject every valid report from the replacement as stale. Keep the latest
    // turn/context snapshot, which is still useful history, but detach all
    // account-scoped figures once the replacement is known to exist.
    if (clearAgentScopedUsage(state)) state.revision += 1;
    state.agent = created;
    state.agentId = created.agentId;
    recordAttachedConfig();
    markConfigResumePending(state, false);
    schedulePlanAccountRefresh();
    return created;
  } catch (error) {
    state.workspaceWarmRelease = undefined;
    state.hostedMcpClose = undefined;
    state.hostedMcpTools = undefined;
    state.agentLocalOptions = undefined;
    await Promise.allSettled([
      ...(releaseWarmWorkspace ? [releaseWarmWorkspace()] : []),
      ...(closeHosted ? [closeHosted()] : []),
    ]);
    throw error;
  }
}

/**
 * Dispose an agent that finished attaching after its session was closed.
 *
 * The close could not recall the create or resume it raced, so the result is
 * owned here: installed on a closed session it would be a live agent nothing
 * will ever release. A failed dispose is observed and still refuses the attach.
 */
async function disposeIfClosed(state: SessionState, agent: SDKAgent): Promise<void> {
  if (!state.closed) return;
  await Promise.resolve()
    .then(() => agent[Symbol.asyncDispose]())
    .catch(() => undefined);
  throw new SessionClosedError();
}

function clearAgentScopedUsage(state: SessionState): boolean {
  const usage = state.usage;
  if (
    !usage ||
    (usage.sessionTokens === undefined &&
      usage.sessionTokenFloor === undefined &&
      usage.costUsd === undefined &&
      usage.account === undefined)
  ) {
    return false;
  }
  const {
    sessionTokens: _sessionTokens,
    sessionTokenFloor: _floor,
    costUsd: _cost,
    account: _account,
    ...rest
  } = usage;
  state.usage = { ...rest, updatedAt: new Date().toISOString() };
  return true;
}

/**
 * Release the SDK agent without touching the session.
 *
 * Called on idle detach and on shutdown. The transcript, journal and agent id
 * all survive, so the next request re-attaches transparently — and because the
 * agent id survives, it re-attaches to the *same* conversation.
 */
export async function detachAgent(state: SessionState): Promise<void> {
  const agent = state.agent;
  const releaseWarmWorkspace = state.workspaceWarmRelease;
  const hostedMcpClose = state.hostedMcpClose;
  state.agent = null;
  state.attachedMcpKey = undefined;
  attachedConfigKeys.delete(state);
  attachedConfigRevisions.delete(state);
  state.workspaceWarmRelease = undefined;
  state.hostedMcpClose = undefined;
  state.hostedMcpTools = undefined;
  state.agentLocalOptions = undefined;
  await Promise.allSettled([
    ...(agent ? [agent[Symbol.asyncDispose]()] : []),
    ...(releaseWarmWorkspace ? [releaseWarmWorkspace()] : []),
    ...(hostedMcpClose ? [hostedMcpClose()] : []),
  ]);
}

/**
 * Restore the checkpoint captured immediately before the selected user turn.
 *
 * Owned work: a permanent close waits for a rewind in flight (it rewrites the
 * provider's store and cannot be recalled halfway), and a closing session
 * starts none. A close that arrives before the first write wins.
 */
export async function rewindSessionHistory(state: SessionState, messageId: string): Promise<void> {
  assertSessionOpen(state);
  if (state.rewinding) throw new SessionConflictError("A Cursor rewind is already in progress");
  const work = rewindOwned(state, messageId);
  const owned: Promise<void> = work.then(
    () => undefined,
    () => undefined,
  );
  state.rewinding = owned;
  try {
    await work;
  } finally {
    if (state.rewinding === owned) state.rewinding = undefined;
  }
}

async function rewindOwned(state: SessionState, messageId: string): Promise<void> {
  if (!state.agentId) throw new Error("This Cursor session has no persisted conversation");
  if (state.status === "running" || state.dispatching) {
    throw new Error("The Cursor session is already running");
  }
  const selectedMessage = state.messages.find(
    (message) => message.role === "user" && message.id === messageId,
  );
  if (!selectedMessage) throw new Error("The selected Cursor message is no longer available");
  if (!selectedMessage.runId) {
    throw new Error("Cursor cannot safely map that message to its stored run");
  }

  await detachAgent(state);
  const store = cursorLocalAgentStore;
  const runs: LocalAgentRunDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.runs.list({
      filter: { agentIds: [state.agentId], limit: 200, ...(cursor ? { cursor } : {}) },
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && runs.length < 2_000);
  runs.sort((left, right) => left.turnNumber - right.turnNumber);
  const userIndex = runs.findIndex((run) => run.runId === selectedMessage.runId);
  const targetRun = userIndex < 0 ? undefined : runs[userIndex];
  const checkpoint = targetRun?.startCheckpointRef;
  if (!targetRun || !checkpoint) throw new Error("Cursor has no checkpoint for that message");
  const agent = await store.agents.get({ agentId: state.agentId });
  if (!agent) throw new Error("Cursor no longer has this agent");
  // The last point at which nothing has been rewritten. Past it the rewind
  // runs to its end and the close waits for it.
  assertSessionOpen(state);
  await store.agents.update({
    agent: {
      ...agent,
      status: "idle",
      activeRunId: null,
      latestCheckpoint: checkpoint,
      updatedAt: Date.now(),
    },
  });
  const discardedRunIds = runs.slice(userIndex).map((run) => run.runId);
  if (discardedRunIds.length > 0) {
    await store.runEvents.delete({ filter: { runIds: discardedRunIds } });
    await store.runs.delete({ filter: { agentIds: [state.agentId], runIds: discardedRunIds } });
  }
  rewindTranscriptTo(state, messageId);
  state.error = undefined;
  boundTranscript(state);
}

export interface ComposerPatch {
  modelId?: string;
  reasoningId?: string;
  modeId?: "build" | "plan";
  fastMode?: boolean;
  parameterValues?: Record<string, string | boolean>;
}

export function parseComposerPatch(body: unknown): ComposerPatch | undefined {
  if (!isObject(body)) return undefined;
  const patch: ComposerPatch = {};
  if (nonBlank(body.modelId)) patch.modelId = body.modelId.trim();
  if (nonBlank(body.model)) patch.modelId ??= body.model.trim();
  if (nonBlank(body.reasoningId)) patch.reasoningId = body.reasoningId.trim();
  if (nonBlank(body.effort)) patch.reasoningId ??= body.effort.trim();
  if (body.mode === "plan" || body.mode === "build") patch.modeId = body.mode;
  if (body.modeId === "plan" || body.modeId === "build") patch.modeId ??= body.modeId;
  if (typeof body.fastMode === "boolean") patch.fastMode = body.fastMode;
  if (isObject(body.parameterValues)) {
    patch.parameterValues = Object.fromEntries(
      Object.entries(body.parameterValues)
        .filter(([, value]) => typeof value === "string" || typeof value === "boolean")
        .slice(0, 64),
    ) as Record<string, string | boolean>;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Record a composer selection. Deliberately does not touch the attached agent.
 *
 * Model and mode are fixed at `Agent.create`, but `dispatchPrompt` sends both
 * explicitly on every turn, so a change takes effect on the next prompt without
 * throwing away a warm agent — or the conversation it holds. That per-send
 * override in `prompt.ts` is the only thing applying the user's choice: remove
 * it as redundant and model and mode selections silently stop working.
 */
export function applyComposerPatch(state: SessionState, patch: ComposerPatch | undefined): boolean {
  if (!patch) return false;
  let changed = false;
  const modelChanged = Boolean(patch.modelId && patch.modelId !== state.composer.selectedModelId);
  if (modelChanged) {
    state.composer = {
      ...state.composer,
      selectedModelId: patch.modelId,
      // A model change invalidates the reasoning selection unless the caller
      // sent one alongside: the axis is per-model, so carrying the old id over
      // would send parameters the new model does not define.
      selectedReasoningId: patch.reasoningId,
      parameterValues: patch.parameterValues ?? {},
    };
    changed = true;
  } else if (patch.reasoningId && patch.reasoningId !== state.composer.selectedReasoningId) {
    state.composer = { ...state.composer, selectedReasoningId: patch.reasoningId };
    changed = true;
  }
  if (patch.modeId && patch.modeId !== state.composer.selectedModeId) {
    state.composer = { ...state.composer, selectedModeId: patch.modeId };
    changed = true;
  }
  if (patch.fastMode !== undefined && patch.fastMode !== state.composer.fastModeEnabled) {
    state.composer = { ...state.composer, fastModeEnabled: patch.fastMode };
    changed = true;
  }
  if (patch.parameterValues && !modelChanged) {
    state.composer = {
      ...state.composer,
      parameterValues: { ...state.composer.parameterValues, ...patch.parameterValues },
    };
    changed = true;
  }
  if (changed) state.revision += 1;
  return changed;
}

/** Store reads in flight while the picker screens one page of agents. */
const RESUME_SCREEN_CONCURRENCY = 8;

/**
 * Drop agents that were warmed and replaced before they ever held a turn.
 *
 * Attach replaces such an agent rather than resuming it, and deliberately
 * leaves the original record alone — a live handle elsewhere may still own
 * that reservation, so deleting it is not the bridge's call. The record is
 * empty by construction, though, so the picker is where it stops being
 * offered. A read that fails keeps the row: an unreadable record is not
 * evidence that there is nothing behind it.
 */
async function withoutUnusedWarmUps(items: SDKAgentInfo[]): Promise<SDKAgentInfo[]> {
  const empty = Array.from({ length: items.length }, () => false);
  let next = 0;
  const screen = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      empty[index] = await hasUnusedInitialRun(items[index]!.agentId).catch(() => false);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RESUME_SCREEN_CONCURRENCY, items.length) }, screen),
  );
  return items.filter((_item, index) => !empty[index]);
}

/**
 * Sessions this workspace can be resumed into.
 *
 * Scoped to `cwd` so the picker offers this environment's own history rather
 * than every agent the user has ever run on this machine. Archived agents
 * (`SDKAgentInfo.archived`, set here or in Cursor) are left out unless asked
 * for: the SDK refuses a follow-up run on one until it is unarchived, so the
 * picker has to restore it first.
 */
export async function listResumableSessions(
  options: { includeArchived?: boolean } = {},
): Promise<JsonObject[]> {
  const { apiKey } = await resolveCredential();
  if (!apiKey) return [];
  const items: SDKAgentInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await cursorAgentApi()
      .list({
        runtime: "local",
        cwd: workingDirectory,
        limit: MAX_RESUME_ENTRIES,
        ...(cursor ? { cursor } : {}),
      })
      .catch(() => ({ items: [], nextCursor: undefined }));
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < 2_000);

  const offered = await withoutUnusedWarmUps(
    items.slice(0, 2_000).filter((item) => options.includeArchived || item.archived !== true),
  );
  // After every live row: the backend caps the list it reads.
  offered.sort((a, b) => Number(a.archived === true) - Number(b.archived === true));
  return offered.map((item) => ({
    // This is the bridge wire shape, not the normalized service shape. The
    // shared backend provider reads `id` here and turns it into `sessionId` for
    // the renderer; returning `sessionId` directly makes it discard every row.
    id: item.agentId,
    ...(item.name?.trim() ? { title: item.name.trim() } : {}),
    ...(item.createdAt ? { createdAt: new Date(item.createdAt).toISOString() } : {}),
    ...(item.lastModified ? { updatedAt: new Date(item.lastModified).toISOString() } : {}),
    status: item.status === "running" ? "running" : item.status === "error" ? "error" : "idle",
    ...(item.summary?.trim() ? { detail: item.summary.trim().slice(0, 200) } : {}),
    ...(item.archived === true ? { archived: true } : {}),
  }));
}

/**
 * Takes an agent out of the resume list, or puts it back. Its conversation
 * stays in the store: archive is never `Agent.delete`. An agent a tab here still
 * holds is refused, because its next run would then fail. A cloud agent id is
 * refused too: this bridge lists only local agents, and the SDK would route that
 * id to the Cursor API.
 */
export async function setResumableAgentArchived(
  agentId: string,
  archived: boolean,
): Promise<"archived" | "unarchived" | "in-use" | "failed"> {
  if (agentId.startsWith("bc-")) return "failed";
  if (
    agentArchiveOperations.has(agentId) ||
    sessionResumesByAgentId.has(agentId) ||
    (archived && [...sessions.values()].some((state) => state.agentId === agentId))
  ) {
    return "in-use";
  }
  // Reserve synchronously: adoption and other archive mutations refuse while
  // the SDK call is in flight, before either side can change the agent.
  agentArchiveOperations.add(agentId);
  try {
    const api = cursorAgentApi();
    const options = { cwd: workingDirectory };
    await (archived ? api.archive(agentId, options) : api.unarchive(agentId, options));
  } catch (error) {
    log.warn("agent.archive-failed", { archived, error: formatLogError(error, { stack: false }) });
    return "failed";
  } finally {
    agentArchiveOperations.delete(agentId);
  }
  return archived ? "archived" : "unarchived";
}

/**
 * Adopt an existing SDK agent as a new bridge session, replaying its history.
 *
 * The replay is best-effort and deliberately so. A resumed conversation whose
 * history could not be read is still a working session — the model retains its
 * own context regardless of what this transcript shows — so a failed replay
 * degrades to an empty transcript rather than a failed resume.
 */
function resumePolicyKey(
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): string {
  const resolved = resolveCursorExecutionPolicy(policy);
  return JSON.stringify({
    id: resolved.id,
    sandbox: resolved.sandbox,
    approvals: resolved.approvals,
    projectResources: resolved.projectResources,
    capabilityPolicy: resolved.capabilityPolicy ?? null,
    networkAccess: resolved.networkAccess ?? null,
    toolPolicy: resolved.toolPolicy ?? null,
  });
}

function resumeComposerConflicts(state: SessionState, patch: ComposerPatch | undefined): boolean {
  if (!patch) return false;
  if (patch.modelId && patch.modelId !== state.composer.selectedModelId) return true;
  if (patch.modeId && patch.modeId !== state.composer.selectedModeId) return true;
  if (patch.reasoningId && patch.reasoningId !== state.composer.selectedReasoningId) return true;
  if (typeof patch.fastMode === "boolean" && patch.fastMode !== state.composer.fastModeEnabled) {
    return true;
  }
  return false;
}

export async function resumeSession(
  agentId: string,
  patch: ComposerPatch | undefined,
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
  agentMcp?: AgentMcpConnection,
): Promise<SessionState> {
  if (agentArchiveOperations.has(agentId)) {
    throw new SessionConflictError(
      "This Cursor conversation is being archived or restored; retry once it completes",
    );
  }
  const requestedPolicyKey = resumePolicyKey(policy);
  const requestedMcpKey = mcpConnectionKey(agentMcp);
  const existing = Array.from(sessions.values()).find((state) => state.agentId === agentId);
  if (existing?.closed) {
    throw new SessionConflictError(
      "This Cursor session is closing; retry once the close completes",
    );
  }
  if (existing) {
    if (
      resumePolicyKey(existing.policy) !== requestedPolicyKey ||
      resumeComposerConflicts(existing, patch)
    ) {
      throw new SessionConflictError(
        "Cursor session is already adopted under a different execution policy",
      );
    }
    if (agentMcp) existing.agentMcp = agentMcp;
    return existing;
  }
  const pending = sessionResumesByAgentId.get(agentId);
  if (pending) {
    if (
      pending.policyKey !== requestedPolicyKey ||
      pending.composerKey !== JSON.stringify(patch ?? {}) ||
      pending.mcpKey !== requestedMcpKey
    ) {
      throw new SessionConflictError(
        "Cursor session is already being resumed with a different execution policy",
      );
    }
    return pending.promise;
  }

  const operation = (async () => {
    // A restored close of this same conversation cancels every run of it that
    // it finds. Finished first, so it can never cancel the run this adoption
    // recovers or the next prompt starts.
    if (hasTombstoneForAgent(agentId)) await finishTombstonesForAgent(agentId);
    const state = newSessionState(undefined, resolveCursorExecutionPolicy(policy));
    state.agentId = agentId;
    state.agentMcp = agentMcp;
    applyComposerPatch(state, patch);
    state.composer = await hydrateComposer(state.composer);
    await hydrateHistory(state, { skipRunning: true }).catch(() => undefined);
    sessions.set(state.id, state);
    // Attach a surviving run before returning so `recoveringRun` is only set when
    // a live stream is actually being rebuilt — not a permanently settled dummy.
    await recoverActiveRun(state);
    return state;
  })();
  sessionResumesByAgentId.set(agentId, {
    promise: operation,
    policyKey: requestedPolicyKey,
    composerKey: JSON.stringify(patch ?? {}),
    mcpKey: requestedMcpKey,
  });
  try {
    return await operation;
  } finally {
    const current = sessionResumesByAgentId.get(agentId);
    if (current?.promise === operation) {
      sessionResumesByAgentId.delete(agentId);
    }
  }
}

const agentArchiveOperations = new Set<string>();

const sessionResumesByAgentId = new Map<
  string,
  { promise: Promise<SessionState>; policyKey: string; composerKey: string; mcpKey: string }
>();

/**
 * Rebuild the transcript from the SDK's own record of past runs.
 *
 * Runs are read rather than messages: `Agent.messages.list` reports only the
 * user and assistant text, which would silently drop every tool call from a
 * resumed session. A run's conversation carries the full step list, and its
 * tool calls are the same shape a live turn emits, so they render identically.
 */
async function hydrateHistory(
  state: SessionState,
  options?: { skipRunning?: boolean },
): Promise<void> {
  if (!state.agentId) return;
  const runs = await listAllRuns(state.agentId);
  for (const run of runs) {
    // A still-running run is rebuilt from its replay-and-tail stream. Hydrating
    // it here and then replaying the same events would duplicate every row.
    if (options?.skipRunning && run.status === "running") continue;
    if (!run.supports("conversation")) continue;
    const turns = await run.conversation().catch(() => []);
    for (const turn of turns) {
      appendHistoricTurn(state, turn, run.id);
      // A long history is rebuilt across many awaits; bound it as it grows
      // rather than holding every run in memory until the end.
      boundTranscriptDuringStreaming(state);
    }
  }
  boundTranscript(state);
  state.revision += 1;
}

/** Re-adopt a local run that survived a bridge restart. */
async function recoverActiveRun(state: SessionState): Promise<void> {
  if (!state.agentId || state.activeRun || state.status === "running") return;
  const runs = await listAllRuns(state.agentId).catch(() => []);
  const active = [...runs].reverse().find((run) => run.status === "running");
  if (!active) return;
  // Re-adopt the SDK agent before tailing its surviving run. Agent.resume is
  // where local custom-tool callbacks are registered after a bridge restart;
  // observing the Run directly would recover output while leaving any pending
  // workflow-result invocation without an executor.
  await ensureAgent(state);
  state.activeRun = active;
  state.activeRunRecovered = true;
  // What the steer fence judges a recovered run by: one created after the
  // fence last overflowed cannot be a run whose history it dropped.
  state.activeRunCreatedAt = active.createdAt;
  state.status = "running";
  state.turnStartedAt = active.createdAt;
  beginAssistantTurn(state);
  state.cancelTurn = () => active.cancel();
  state.revision += 1;
  const unsubscribe = active.onDidChangeStatus(() => {
    state.revision += 1;
  });
  // The provider's own reports for the tail of the run, by native call id. No
  // probe window opens here: what the workspace holds now says nothing about
  // what these calls did before this process existed.
  const evidence = trackTurnEvidence(state.id, { mode: "reconciliation" });
  state.recoveringRun = (async () => {
    try {
      for await (const event of active.stream()) {
        applyRecoveredStreamEvent(state, event, evidence);
      }
      const result: { status?: string } | undefined = await active.wait();
      evidence.end({
        phase:
          result?.status === "cancelled"
            ? "cancelled"
            : result?.status === "finished"
              ? "succeeded"
              : result?.status === "error"
                ? "failed"
                : "unknown",
        terminal: true,
      });
      // The whole transcript is rebuilt from the SDK's record, so everything
      // positional about the old one — open blocks, the assistant message the
      // turn was writing into, readers' absolute offsets — goes with it.
      state.messages = [];
      state.uncheckedTranscriptBytes = 0;
      beginAssistantTurn(state);
      startTranscriptEpoch(state);
      await hydrateHistory(state);
      state.status = active.status === "error" ? "error" : "idle";
      state.error = active.error?.message;
    } catch (error) {
      state.status = "error";
      state.error = error instanceof Error ? error.message : "Cursor run recovery failed";
    } finally {
      evidence.end({ phase: "unknown", terminal: false });
      unsubscribe();
      if (state.activeRun === active) {
        state.activeRun = undefined;
        state.activeRunRecovered = undefined;
        state.activeRunCreatedAt = undefined;
      }
      state.cancelTurn = undefined;
      state.recoveringRun = undefined;
      state.revision += 1;
    }
  })();
}

function applyRecoveredStreamEvent(
  state: SessionState,
  event: unknown,
  evidence: TurnEvidence,
): void {
  if (!isObject(event)) return;
  const update = isObject(event.update) ? event.update : event;
  if (typeof update.type !== "string") return;
  evidence.observe(update);
  applyInteractionUpdate(state, update);
}

function appendHistoricTurn(state: SessionState, turn: unknown, runId: string): void {
  if (!isObject(turn) || !isObject(turn.turn)) return;
  if (turn.type === "shellConversationTurn") {
    appendHistoricShellTurn(state, turn.turn);
    return;
  }
  const body = turn.turn;
  const userTexts = historicUserTexts(body);
  for (const userText of userTexts) {
    pushMessage(state, "user", userText, [], undefined, { runId });
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) return;

  // One row per model step, as the live stream writes them (see
  // `translate.ts`). The record keeps no step boundaries, so a row ends where
  // prose or reasoning follows a tool call: the model was called again with
  // the call's result. A step that made only tool calls joins the one before.
  let row = newHistoricRow();
  // Whether this turn has produced a plan yet; see `pushHistoricRow`.
  let planned = false;
  for (const step of body.steps) {
    if (!isObject(step) || !isObject(step.message)) continue;
    const prose =
      (step.type === "assistantMessage" || step.type === "thinkingMessage") &&
      nonBlank(step.message.text);
    if (prose && row.parts.some((part) => part.type === "tool-invocation")) {
      planned = pushHistoricRow(state, row, planned);
      row = newHistoricRow();
    }
    const { parts, messageId } = row;
    if (step.type === "assistantMessage" && nonBlank(step.message.text)) {
      row.content += step.message.text;
      parts.push({
        type: "text",
        content: step.message.text,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
      });
    } else if (step.type === "thinkingMessage" && nonBlank(step.message.text)) {
      parts.push({
        type: "thinking",
        content: step.message.text,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
      });
    } else if (step.type === "toolCall") {
      const rendered = renderToolCall(step.message, state.health);
      const callId = `${messageId}:tool:${parts.length}`;
      parts.push({
        type: "tool-invocation",
        content: rendered.toolTitle ?? rendered.toolName,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
        // A historic call has no live call id, so key it on its position. It
        // only has to be unique within this message: nothing will patch it.
        toolUseId: callId,
        toolName: rendered.toolName,
        toolTitle: rendered.toolTitle,
        ...(rendered.toolArgs ? { toolArgs: rendered.toolArgs } : {}),
        ...(rendered.toolOutput !== undefined ? { toolOutput: rendered.toolOutput } : {}),
        ...(rendered.toolError !== undefined ? { toolError: rendered.toolError } : {}),
        ...(rendered.toolDiff ? { toolDiff: rendered.toolDiff } : {}),
        ...(rendered.toolDurationMs !== undefined
          ? { toolDurationMs: rendered.toolDurationMs }
          : {}),
        ...(rendered.subagent?.modelId ? { subagentModelId: rendered.subagent.modelId } : {}),
        toolState: rendered.toolError === undefined ? "success" : "failure",
        // Replayed history is settled by definition: whatever these sub-agents
        // were doing, they are not doing it on this bridge's watch.
        ...(rendered.subagent ? { agentState: "finished" as const } : {}),
      });
      if (rendered.toolImage) {
        parts.push({
          type: "image",
          content: rendered.toolImage.caption,
          sourcePartId: `image:${callId}`,
          sourceMessageId: messageId,
          createdAt: new Date().toISOString(),
          fileUrl: `file://${rendered.toolImage.filePath}`,
          filename: rendered.toolImage.filePath,
          imageSource: rendered.toolImage.imageSource,
        });
      }
    }
  }
  pushHistoricRow(state, row, planned);
}

interface HistoricRow {
  messageId: string;
  parts: BridgeMessagePart[];
  content: string;
}

function newHistoricRow(): HistoricRow {
  return { messageId: randomBytes(12).toString("hex"), parts: [], content: "" };
}

/**
 * Append one replayed step, returning whether the turn has produced a plan.
 *
 * Plan review is marked from the step that produced the plan to the end of its
 * turn. A live plan-mode turn marks every step's row, and the tab offers the
 * Approve and Build controls only while the newest assistant row is marked, so
 * marking just the plan's own row lost them whenever the model said something
 * after it — "The plan is ready." is a step of its own. The record keeps no
 * mode, so the plan is the only evidence and rows before it stay unmarked.
 */
function pushHistoricRow(state: SessionState, row: HistoricRow, planned: boolean): boolean {
  if (row.parts.length === 0) return planned;
  const planReview =
    planned ||
    row.parts.some(
      (part) => part.type === "tool-invocation" && isCreatePlanToolName(part.toolName),
    );
  pushMessage(state, "assistant", row.content, row.parts, row.messageId, { planReview });
  return planReview;
}

function historicUserTexts(body: Record<string, unknown>): string[] {
  // A sent prompt carries the shared agent instructions in a frame
  // (`cursorPromptText`); the row shows only what the user wrote. Both lists
  // are stripped alike, because `consume` matches one against the other.
  const extract = (value: unknown): string | undefined => {
    const raw =
      typeof value === "string"
        ? value
        : isObject(value) && nonBlank(value.text)
          ? value.text
          : undefined;
    return raw === undefined ? undefined : stripSystemInstructions(raw);
  };

  const texts: string[] = [];
  const remaining = new Map<string, number>();
  if (Array.isArray(body.userMessages)) {
    for (const message of body.userMessages) {
      const text = extract(message);
      if (!text) continue;
      texts.push(text);
      remaining.set(text, (remaining.get(text) ?? 0) + 1);
    }
  }

  const consume = (text: string | undefined): boolean => {
    if (!text) return false;
    const count = remaining.get(text) ?? 0;
    if (count <= 0) return false;
    remaining.set(text, count - 1);
    return true;
  };

  const alias = extract(isObject(body.userMessage) ? body.userMessage : undefined);
  if (alias && !consume(alias) && texts.length === 0) {
    texts.push(alias);
  }

  if (Array.isArray(body.steps)) {
    for (const step of body.steps) {
      if (!isObject(step) || step.type !== "userMessage") continue;
      const text = extract(step.message);
      if (!text) continue;
      if (consume(text)) continue;
      texts.push(text);
    }
  }
  return texts;
}

function isCreatePlanToolName(toolName: string | undefined): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "createplan" || normalized === "create_plan";
}

function appendHistoricShellTurn(state: SessionState, body: Record<string, unknown>): void {
  const command =
    isObject(body.shellCommand) && nonBlank(body.shellCommand.command)
      ? body.shellCommand.command
      : undefined;
  if (!command) return;
  const rendered = renderToolCall({
    type: "shell",
    args: body.shellCommand,
    ...(isObject(body.shellOutput)
      ? { result: { status: "success", value: body.shellOutput } }
      : {}),
  });
  const messageId = randomBytes(12).toString("hex");
  pushMessage(
    state,
    "assistant",
    "",
    [
      {
        type: "tool-invocation",
        content: rendered.toolTitle ?? command,
        sourcePartId: `${messageId}:0`,
        sourceMessageId: messageId,
        toolUseId: `${messageId}:tool:0`,
        toolName: "shell",
        toolTitle: rendered.toolTitle,
        ...(rendered.toolArgs ? { toolArgs: rendered.toolArgs } : {}),
        ...(rendered.toolOutput !== undefined ? { toolOutput: rendered.toolOutput } : {}),
        ...(rendered.toolDurationMs !== undefined
          ? { toolDurationMs: rendered.toolDurationMs }
          : {}),
        toolState: "success",
      },
    ],
    messageId,
  );
}

function pushMessage(
  state: SessionState,
  role: "user" | "assistant",
  content: string,
  parts: BridgeMessagePart[],
  messageId = randomBytes(12).toString("hex"),
  extras?: { runId?: string; planReview?: boolean },
): void {
  const message: BridgeMessage = {
    id: messageId,
    role,
    content,
    parts:
      parts.length > 0 || !content
        ? parts
        : [
            {
              type: "text",
              content,
              sourcePartId: `${messageId}:0`,
              sourceMessageId: messageId,
            },
          ],
    createdAt: new Date().toISOString(),
    ...(extras?.runId ? { runId: extras.runId } : {}),
    ...(extras?.planReview ? { planReview: true } : {}),
  };
  state.messages.push(message);
  chargeTranscript(state, Buffer.byteLength(JSON.stringify(message)));
}
