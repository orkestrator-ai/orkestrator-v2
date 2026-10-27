/**
 * Shared message model used by native-mode chat UIs.
 *
 * Agent clients should normalize their provider-specific events/messages into
 * this shape before rendering. Renderer components should depend on this file,
 * not on Claude/OpenCode/Codex SDK payloads.
 */

import type { PermissionRuleApplication } from "@orkestrator/protocol/permission-rules";
import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";
import type {
  NativeAgentBackgroundTaskKind,
  NativeAgentBackgroundTaskUsage,
} from "@orkestrator/protocol/native-agent";
import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";
import type { UserPromptPresentationKind } from "@orkestrator/protocol/review-evidence-frames";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { AgentMailKind, AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";

export interface NativeToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
  /**
   * A diff body exists but was left out of this projection, to be fetched
   * through the part's `detailRef` on expand. Providers that identify a file
   * mutation by diff content rather than tool name would otherwise be
   * indistinguishable from a location-only hint on a read/search tool, and
   * would lose the edit treatment until the user expanded the row.
   */
  deferred?: boolean;
}

export type NativeToolState = "success" | "failure" | "pending";
export type NativeAgentState = "active" | "finished" | "failed";
export type NativeBackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "paused";

export interface NativeBackgroundTask {
  id: string;
  description?: string;
  /** Absent when recovered from transcript tool results rather than a snapshot. */
  status?: NativeBackgroundTaskStatus;
  /** Backend-reported launch clock, as an ISO timestamp. */
  startedAt?: string;
  /**
   * Backend-reported terminal edge, as an ISO timestamp.
   *
   * The transcript position a settled card holds is read from this, so the
   * renderer never has to observe the transition itself. Absent while the task
   * is live, and for a bridge that predates the field — which reads as "no
   * recorded position", leaving the card in its launch row.
   */
  settledAt?: string;
  /** Why the task failed or was stopped, when the backend recorded a reason. */
  error?: string;
  /** The provider's one-line report from the task's terminal edge. */
  summary?: string;
  /** Path of the task's full output in its environment's filesystem. */
  outputFile?: string;
  usage?: NativeAgentBackgroundTaskUsage;
  /**
   * The agent running the task, when it is one; see the protocol summary's
   * `agentRole`. `main-session` is the conversation's own agent, backgrounded.
   */
  agentRole?: string;
  /** What sort of work the task is; see the protocol summary's `kind`. */
  kind?: NativeAgentBackgroundTaskKind;
  /** The task whose agent launched this one; see the protocol summary. */
  parentTaskId?: string;
  /** The prompt an agent or workflow task was started with. */
  prompt?: string;
  /** The command a shell task runs, when the provider captured it. */
  command?: string;
  /** The last part of a shell task's output. */
  outputTail?: string;
  workflowName?: string;
  /** The tool the task's agent most recently ran. */
  lastToolName?: string;
  /** The provider's live one-line status for the task. */
  progressSummary?: string;
  /** Total time the task spent paused, in milliseconds. */
  pausedMs?: number;
  /** See the protocol summary's `endReason`. */
  endReason?: "process-restart" | "resume-cleanup";
}

/**
 * A point-in-time view of the agent's task list.
 *
 * Providers whose task tools mutate a single task per call (Claude's
 * TaskCreate/TaskUpdate) have their backend replay those calls and supply the
 * resulting list here, so the renderer never reconstructs it — see
 * `@orkestrator/protocol/task-list`, the one implementation.
 */
export type { TaskListSnapshot, TaskSnapshotItem } from "@orkestrator/protocol/task-list";

export interface NativeBasePart {
  content: string;
  /** Opaque backend-owned reference for heavy output/diff fields. */
  detailRef?: string;
  /** Opaque session-scoped reference for an exact provider-reported image path. */
  imageDetailRef?: string;
  /** Original attachment name when the readable path uses a staged/generated name. */
  filename?: string;
  /** Provider timestamp for when this individual message part first arrived. */
  createdAt?: string;
  /**
   * Backend timestamp for when this part's long-running child went terminal.
   *
   * Distinct from `createdAt`, which is the launch. This is the position a
   * settled agent card holds — the transcript had reached here when the child
   * stopped — and it is stamped by the bridge from the record carrying the
   * result, so it is identical every time the transcript is replayed.
   */
  settledAt?: string;
  sourcePartId?: string;
  sourceMessageId?: string;
  fileUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: NativeToolState;
  /**
   * Lifecycle of an agent spawned by this tool.
   *
   * This is deliberately separate from `toolState`: background-agent tools
   * can return successfully as soon as the child launches, while the child is
   * still active.
   */
  agentState?: NativeAgentState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: NativeToolDiffMetadata;
  /**
   * What a shell call changed in its worktree, measured by the bridge around
   * the command because its input cannot say. Kept apart from `toolDiff`,
   * which marks a row as an edit and would route it to the edit card.
   */
  commandChanges?: MeasuredWorkspaceChange;
  /**
   * The provider's permission layer refused this call before it ran, as
   * opposed to the tool running and failing. `source` names what decided
   * (for Claude: `rule`, `classifier`, `mode`…) when the provider says.
   */
  toolDenied?: { reason?: string; source?: string };
  /**
   * How long a settled tool call ran, as the provider reported it or as the
   * adapter measured between the provider's own start and end events for that
   * call. Absent when unknown, and never set while the call is still running:
   * a live row's clock is `progress.elapsedMs`, not this.
   */
  toolDurationMs?: number;
  toolUseCount?: number;
  tokenCount?: number;
  tokenCountText?: string;
  /** Hint for agent rows when a provider can report tokens but not child activity. */
  agentUsageDisplay?: "token-only";
  toolUseId?: string;
  parentTaskUseId?: string;
  isMcpTool?: boolean;
  mcpServerName?: string;
  /** Background task represented or acted on by this tool row. */
  backgroundTask?: NativeBackgroundTask;
  /**
   * Bounded task id recovered before a heavy launch result is moved behind
   * `detailRef`. This is correlation metadata only; lifecycle still comes from
   * the authoritative background-task snapshot.
   */
  backgroundTaskId?: string;
  /** Task list state immediately after this tool call, for task tools. */
  taskSnapshot?: TaskListSnapshot;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions?: NativeMessagePart[];
  subagentActionCount?: number;
  /** The model the child ran on, when the provider names one. */
  subagentModelId?: string;
  /**
   * The reasoning effort the child ran at, in the provider's own vocabulary
   * (`low`, `high`, `xhigh`…), when the provider names one. Display-only: it
   * is never mapped onto another provider's levels.
   */
  subagentReasoningEffort?: string;
  /**
   * How this sub-agent row was discovered.
   *
   * `part` is a provider's own first-class sub-agent record; `tool` is the
   * heuristic that recognises a task-shaped tool call. Both exist for OpenCode,
   * so the two are deduplicated by child session id and this says which
   * survived.
   */
  subagentSource?: "tool" | "part";
  /**
   * Context occupancy immediately *before* a compaction, on a `compaction`
   * part. The tokens after are not reported: providers disagree on whether the
   * post-compaction number is known at the boundary, and a wrong "after" reads
   * as a measurement rather than the guess it would be.
   */
  compactedTokensBefore?: number;
  /** Attempt number on a `retry` part, when the provider counts them. */
  retryAttempt?: number;
  /**
   * Where an `image` part came from: a user attachment, a model-generated
   * image, or an image the agent read from the workspace. The three are shown
   * the same way but mean different things in a transcript.
   */
  imageSource?: "attachment" | "generated" | "viewed";
  /** How long a `progress` sub-line's tool call has been running. */
  elapsedMs?: number;
  /** Severity of a `status` row, and of an advisory rendered as one. */
  severity?: "info" | "warning" | "error";
  /**
   * Live progress for this tool call, attached at projection time by matching
   * `toolUseId`.
   *
   * A hint over the authoritative `toolState`, never a substitute: a missed
   * progress event costs a sub-line, not correctness, so nothing downstream may
   * read the absence of one as "not running".
   */
  progress?: { content: string; elapsedMs?: number; createdAt?: string };
}

export interface NativeTextPart extends NativeBasePart {
  type: "text";
}

/** A transcript excerpt the user attached as context for this prompt. */
export interface NativeTranscriptReferencePart extends NativeBasePart {
  type: "transcript-reference";
  reference: number;
  comment?: string;
}

export interface NativeAsyncQuestionPart extends NativeBasePart {
  type: "async-question";
  asyncQuestion: {
    itemId: string;
    questions: Array<{ id: string; title: string; options: string[] }>;
  };
}

export interface NativeThinkingPart extends NativeBasePart {
  type: "thinking";
}

export interface NativeFilePart extends NativeBasePart {
  type: "file";
}

export interface NativeToolInvocationPart extends NativeBasePart {
  type: "tool-invocation";
}

export interface NativeToolResultPart extends NativeBasePart {
  type: "tool-result";
}

export interface NativeSubagentPart extends NativeBasePart {
  type: "subagent";
}

/**
 * A context compaction boundary.
 *
 * `content` is the summary the provider produced, which may be empty — several
 * providers report the boundary without one. The row is worth showing either
 * way: it is the point after which the model no longer remembers what is above
 * it, which is the single most confusing thing about a long session.
 */
export interface NativeCompactionPart extends NativeBasePart {
  type: "compaction";
}

/**
 * A provider retrying a request.
 *
 * `toolState` carries the lifecycle: `pending` while retrying, `success` or
 * `failure` once it settles. A retry that never settles is a bug in the
 * adapter, not a state to render — a permanently pending retry row is exactly
 * the stale card this kind exists to replace.
 */
export interface NativeRetryPart extends NativeBasePart {
  type: "retry";
}

/**
 * An image in the transcript.
 *
 * Bytes never travel inline: `fileUrl` or `detailRef` locates them and the
 * renderer fetches lazily. `content` is the caption or alt text.
 */
export interface NativeImagePart extends NativeBasePart {
  type: "image";
}

/**
 * A short provider status line that belongs in the flow.
 *
 * For things the user should see where they happen rather than in a panel: a
 * rerouted model, a cleared conversation, a tool-use summary. Not for errors
 * that end a turn — those are the turn's own failure.
 */
export interface NativeStatusPart extends NativeBasePart {
  type: "status";
}

export interface NativeToolGroupPart extends NativeBasePart {
  type: "tool-group";
  parts: NativeMessagePart[];
}

export interface NativeTaskGroupPart extends NativeBasePart {
  type: "task-group";
  task: NativeToolInvocationPart;
  /** All activity emitted by this agent, including reasoning and final text. */
  childTools: NativeMessagePart[];
}

export type NativeAgentActivityPart = NativeSubagentPart | NativeTaskGroupPart;

/**
 * A published transcript artifact. Only the backend's publication ledger
 * produces this part; text, JSON or tool output that looks like a reference
 * never becomes one. The renderer resolves content by reference.
 */
export interface NativeArtifactPart extends NativeBasePart {
  type: "artifact";
  artifact: TranscriptArtifactRef;
  publishedAt: string;
  conversationSequence: number;
}

/**
 * A shell command the user ran with `!` from the composer, backend-owned
 * (`list_user_commands`). Synthesized by the tab, never by a provider: the
 * agent only reads about it at the start of its next turn.
 */
export interface NativeUserCommandPart extends NativeBasePart {
  type: "user-command";
  userCommand: UserCommandRecord;
}

/**
 * An approval an Orkestrator permission rule answered (todo 0723),
 * backend-owned (`list_permission_rules`). Synthesized by the tab: the
 * provider only saw a one-time approval.
 */
export interface NativePermissionRulePart extends NativeBasePart {
  type: "permission-rule";
  application: PermissionRuleApplication;
  /** Whether the rule still exists, so the row can offer to remove it. */
  ruleExists: boolean;
}

export interface NativeAgentGroupPart extends NativeBasePart {
  type: "agent-group";
  parts: NativeAgentActivityPart[];
}

export type NativeMessagePart =
  | NativeTextPart
  | NativeTranscriptReferencePart
  | NativeAsyncQuestionPart
  | NativeThinkingPart
  | NativeFilePart
  | NativeToolInvocationPart
  | NativeToolResultPart
  | NativeSubagentPart
  | NativeAgentGroupPart
  | NativeToolGroupPart
  | NativeTaskGroupPart
  | NativeCompactionPart
  | NativeRetryPart
  | NativeImagePart
  | NativeStatusPart
  | NativeArtifactPart
  | NativeUserCommandPart
  | NativePermissionRulePart;

export interface NativeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: NativeMessagePart[];
  createdAt: string;
  /**
   * Persisted provider message at the end of a display row that coalesces
   * multiple source messages. Forks use this instead of the stable display id.
   */
  latestSourceMessageId?: string;
  /**
   * First source message of a coalesced display row. The row's own `id` is a
   * surviving identity that history merging in front does not rename; this
   * says where the row now starts.
   */
  earliestSourceMessageId?: string;
  /**
   * Earliest source-row clock represented by a coalesced display row.
   * Settled child cards use it for placement while `createdAt` remains the
   * latest activity clock shown in the row footer.
   */
  settleAnchorCreatedAt?: string;
  /** Provider/backend-observed model that produced this assistant message. */
  modelId?: string;
  turnId?: string;
  /** Typed plan-review marker used by the shared Codex/Cursor presentation slot. */
  planReview?: boolean;
  /** Backend-authenticated display treatment for this user message. */
  promptPresentation?: UserPromptPresentationKind;
  /**
   * Presentation-only report a Fix tab pins above its opening prompt.
   *
   * The provider already received the findings in the address or custom-fix
   * prompt. This field is the durable Multi Review report so the transcript can
   * render the same structured object the review tab already owns.
   */
  promptEvidence?: StructuredReviewReport;
  /**
   * Structured agent mail behind a client-only peer-mail row, parsed from the
   * carrier's JSON payload. The renderer draws the mail tile from this rather
   * than reading `content` back.
   */
  peerMail?: PeerMailPresentation;
}

/** One delivered agent-mail message, as the transcript tile presents it. */
export interface PeerMailPresentation {
  messageId: string;
  kind: AgentMailKind;
  /** Display name of the sender. */
  sender: string;
  subject?: string;
  /** The trust line shown above an expanded body. */
  warning: string;
  /** The sender's Markdown body, exactly as written. */
  body: string;
  /** Workflow notices only: what the notice is about and how to weigh it. */
  notice?: AgentMailNotice;
  /** Sender and recipient participant keys, when known: the tile opens their conversation. */
  participants?: [string, string];
  /** `out` for mail this transcript's agent sent; absent for mail it received. */
  direction?: "in" | "out";
  /** Delivery state, for mail this agent sent. */
  status?: { label: string; tone: "muted" | "progress" | "warning" | "error" };
}
