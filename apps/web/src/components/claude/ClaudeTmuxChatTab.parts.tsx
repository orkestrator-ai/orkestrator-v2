// Claude tmux mode shared models, prompt cards, and compose bar.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  History,
  Plus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks";
import { Button } from "@/components/ui/button";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import {
  parseSlashCommands,
  type SlashCommand,
} from "@/lib/chat/slash-commands";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useFileSearch } from "@/hooks/useFileSearch";
import {
  useNativeComposeBarPaste,
  type PastedImageAttachment,
} from "@/hooks/useNativeComposeBarPaste";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
import { createUuid } from "@/lib/uuid";
import { replyHook, type TmuxPendingHook } from "@/lib/claude-tmux-client";
import { escapePathForTerminalInput } from "@orkestrator/protocol/tmux-prompt";
import {
  type TmuxSelectionOption,
  type TmuxSelectionPrompt,
} from "@orkestrator/protocol/tmux-observation";
import {
  payloadToApproval,
  payloadToElicitation,
  payloadToPermission,
  payloadToPlan,
  payloadToQuestion,
  useClaudeTmuxStore,
  type TmuxPendingApproval,
  type TmuxPendingElicitation,
  type TmuxPendingPermission,
  type TmuxPendingPlan,
  type TmuxPendingQuestion,
  type TmuxInfoEvent,
  type TmuxAttachment,
  type TmuxQueuedMessage,
} from "@/stores/claudeTmuxStore";
import { serializeClaudeQuestionAnswer } from "@orkestrator/protocol/agent-interactions";
import type { ClaudeEffortLevel, ClaudeModel } from "@/lib/claude-client";
import {
  tmuxPlanDraftKey,
  tmuxElicitationDraftKey,
  usePromptDraftField,
} from "@/stores/promptDraftStore";
import { moveAgentPrompt, removeAgentPrompt } from "@/lib/prompt-queue-sources";
import { composerOccupiedError } from "@/lib/prompt-queue-errors";
import { fallbackReasoningId } from "@orkestrator/protocol/native-agent";
import type { FileCandidate, FileMention } from "@/types";

export const TMUX_FALLBACK_MODELS: ClaudeModel[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "opus[1m]",
    name: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-fable-5[1m]",
    name: "Fable",
    description:
      "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];
export const DEFAULT_MODEL = "default";

/**
 * Model ids we persisted before switching to SDK-style ids/aliases. Mapped so
 * an old saved preference still resolves to a sensible current model.
 */
export const LEGACY_TMUX_MODEL_ALIASES: Record<string, string> = {
  "claude-fable-5": "default",
  "claude-opus-5": "default",
  "claude-opus-5[1m]": "opus[1m]",
  "claude-opus-4-8": "default",
  "claude-opus-4-7": "default",
  "claude-opus-4-6": "default",
  "claude-sonnet-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-4-5-20251001": "haiku",
};

export const EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
export const EFFORT_DESCRIPTIONS: Record<ClaudeEffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking for everyday tasks",
  high: "Deep reasoning for complex problems",
  xhigh: "Deeper reasoning for the hardest problems",
  max: "Maximum effort (select models only)",
};
export const DEFAULT_EFFORT: ClaudeEffortLevel = "high";
export function resolveTmuxModelPreference(
  modelId: string | undefined,
  models: ClaudeModel[],
): string {
  const normalized = modelId
    ? (LEGACY_TMUX_MODEL_ALIASES[modelId] ?? modelId)
    : undefined;
  return models.some((model) => model.id === normalized)
    ? normalized!
    : DEFAULT_MODEL;
}

/** Whether `modelId` is one this catalog can actually honour. */
export function tmuxModelIsAvailable(modelId: string, models: ClaudeModel[]): boolean {
  const normalized = LEGACY_TMUX_MODEL_ALIASES[modelId] ?? modelId;
  return models.some((model) => model.id === normalized);
}

export function getTmuxModel(id: string, models: ClaudeModel[]): ClaudeModel {
  return (
    models.find((m) => m.id === id) ??
    models.find((m) => m.id === DEFAULT_MODEL) ??
    models[0] ??
    TMUX_FALLBACK_MODELS[0]!
  );
}

export function supportedEffortLevels(model: ClaudeModel): ClaudeEffortLevel[] {
  if (!model.supportsEffort && !model.supportedEffortLevels?.length) return [];
  return model.supportedEffortLevels?.length
    ? model.supportedEffortLevels
    : (["low", "medium", "high"] as ClaudeEffortLevel[]);
}

/**
 * The level to fall back to when the stored preference isn't supported by the
 * selected model. Usually `DEFAULT_EFFORT`, but the SDK owns each model's
 * level list, so don't assume "high" is always present. Callers must ensure
 * `options` is non-empty.
 */
export function fallbackEffort(options: ClaudeEffortLevel[]): ClaudeEffortLevel {
  return (fallbackReasoningId(options) as ClaudeEffortLevel | undefined) ?? options[0]!;
}

/**
 * Latest tmux catalog request per environment.
 *
 * Discovery belongs to the backend/environment lifecycle, not the mounted tab.
 * Keeping the generation outside React lets a successful request finish after
 * unmount while preventing an older response from replacing a newer refresh.
 */
export const claudeCatalogRequestGenerations = new Map<string, number>();

/**
 * Prefer the live model list the Claude bridge fetched from the Agent SDK
 * (shared via the claude store) over the static fallback. The "default"
 * sentinel is guaranteed to be present either way.
 */
export function tmuxModelList(sdkModels: ClaudeModel[]): ClaudeModel[] {
  if (sdkModels.length === 0) return TMUX_FALLBACK_MODELS;
  return sdkModels.some((m) => m.id === DEFAULT_MODEL)
    ? sdkModels
    : [TMUX_FALLBACK_MODELS[0]!, ...sdkModels];
}

/**
 * Claude Code's built-in slash commands. In tmux mode we ship a fixed list
 * (no SDK to enumerate) and forward the literal command text to the TUI on
 * submit, where Claude Code dispatches it just like a user typed it.
 *
 * Custom user / project commands aren't included here — they're still
 * usable by typing them manually.
 */
export const TMUX_BUILTIN_SLASH_COMMANDS: SlashCommand[] = parseSlashCommands([
  "/help - Get help with using Claude Code",
  "/config - Open settings (theme, model, etc.)",
  "/clear - Clear conversation context",
  "/compact - Manually compact the conversation",
  "/usage - View usage and quota information",
  "/cost - Show token usage and cost for the session",
  "/model - Switch the active model",
  "/login - Log in to Claude",
  "/logout - Log out of Claude",
  "/status - Show current session status",
  "/memory - Edit memory / CLAUDE.md files",
  "/permissions - Manage tool permissions",
  "/mcp - Manage MCP servers",
  "/agents - Manage subagents",
  "/hooks - Manage hooks",
  "/doctor - Diagnose installation issues",
  "/bug - Report a bug",
  "/release-notes - View release notes",
  "/fast - Toggle fast mode (Opus with faster output)",
]);
export interface StartScreenProps {
  onStartFresh: () => void;
  onPickResume: () => void;
  selectedModel: string;
  effortLabel: string | null;
  planMode: boolean;
}

/**
 * Shown when a fresh tab opens without an `initialPrompt`. Gives the user the
 * choice to start a new claude session or to resume a previously-recorded
 * one — mirrors the Claude Native tab's behavior.
 */
export function StartScreen({
  onStartFresh,
  onPickResume,
  selectedModel,
  effortLabel,
  planMode,
}: StartScreenProps) {
  return (
    <div className="flex flex-col items-center text-center py-10 px-4 gap-4">
      <div className="space-y-1">
        <h2 className="text-base font-medium">Start a Claude session</h2>
        <p className="text-xs text-muted-foreground">
          Each tab runs its own claude under tmux. Pick a previous session to
          continue where you left off, or start a fresh conversation.
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          Will launch with <span className="font-mono">{selectedModel}</span>
          {effortLabel ? ` at ${effortLabel} effort` : ""}
          {planMode ? " in plan mode" : ""}.
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={onStartFresh}
          className="gap-1.5"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Start fresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onPickResume}
          className="gap-1.5"
        >
          <History className="w-3.5 h-3.5" />
          Resume previous session…
        </Button>
      </div>
    </div>
  );
}

// ─── Structured hook cards ──────────────────────────────────────────────────

export function TmuxPlanCard({
  plan,
  sessionKey,
  onRespond,
}: {
  plan: TmuxPendingPlan;
  sessionKey: string;
  onRespond: (approved: boolean, feedback?: string) => Promise<void> | void;
}) {
  // The feedback draft survives the tab unmounting (environment switches) by
  // living in the prompt-draft store; claudeTmuxStore clears it when the plan
  // request resolves or is withdrawn.
  const draftKey = tmuxPlanDraftKey(sessionKey, plan.eventId);
  const [showFeedback, setShowFeedback] = usePromptDraftField<boolean>(
    draftKey,
    "showFeedback",
    () => false,
  );
  const [feedback, setFeedback] = usePromptDraftField<string>(
    draftKey,
    "feedback",
    () => "",
  );
  const [submitting, setSubmitting] = useState(false);
  const respond = async (approved: boolean, nextFeedback?: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(approved, nextFeedback);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <BlockingPromptCard
      title="Plan ready for review"
      expiresAt={plan.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label="Claude plan ready for review"
      arrivalAnnouncement="Claude is waiting for a plan decision."
      className="mb-3"
    >
      <div className="px-3 py-3">
      {plan.planFilePath && (
        <div className="text-xs font-mono text-muted-foreground mb-2 break-all">
          {plan.planFilePath}
        </div>
      )}
      {plan.plan && (
        <MessageMarkdown
          content={plan.plan}
          className="max-h-80 overflow-auto rounded border border-border/70 bg-background/60 p-3"
        />
      )}
      {plan.allowedPrompts.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          Requests {plan.allowedPrompts.length} plan-scoped permission prompt(s).
        </div>
      )}
      {showFeedback && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="What should Claude change?"
          className="mt-3 w-full min-h-20 resize-none rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none"
        />
      )}
      <div className="flex justify-end gap-2 mt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            showFeedback ? void respond(false, feedback) : setShowFeedback(true)
          }
          disabled={submitting}
        >
          Request changes
        </Button>
        <Button size="sm" onClick={() => void respond(true)} disabled={submitting}>
          Approve plan
        </Button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

export function TmuxPermissionCard({
  permission,
  onRespond,
}: {
  permission: TmuxPendingPermission;
  onRespond: (allow: boolean, updatedPermissions?: unknown[]) => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (allow: boolean, updatedPermissions?: unknown[]) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(allow, updatedPermissions);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <BlockingPromptCard
      title="Claude needs permission"
      expiresAt={permission.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label="Claude needs permission"
      arrivalAnnouncement="Claude is waiting for a permission decision."
      className="mb-3"
    >
      <div className="px-3 py-3">
      <div className="text-sm font-mono text-amber-100 mb-2">
        {permission.toolName}
      </div>
      <ApprovalToolInput
        toolName={permission.toolName}
        toolInput={permission.toolInput}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void respond(false)} disabled={submitting}>
          Deny
        </Button>
        {permission.permissionSuggestions.map((suggestion, index) => (
          <Button
            key={index}
            variant="outline"
            size="sm"
            onClick={() => void respond(true, [suggestion])}
            disabled={submitting}
          >
            Always allow
          </Button>
        ))}
        <Button size="sm" onClick={() => void respond(true)} disabled={submitting}>
          Allow
        </Button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

export function TmuxElicitationCard({
  elicitation,
  sessionKey,
  onRespond,
}: {
  elicitation: TmuxPendingElicitation;
  sessionKey: string;
  onRespond: (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string>,
  ) => Promise<void> | void;
}) {
  const fields = useMemo(
    () => elicitationSchemaFields(elicitation.requestedSchema),
    [elicitation.requestedSchema],
  );
  // Typed field values survive the tab unmounting; claudeTmuxStore clears the
  // draft when the elicitation resolves or is withdrawn.
  const [values, setValues] = usePromptDraftField<Record<string, string>>(
    tmuxElicitationDraftKey(sessionKey, elicitation.eventId),
    "values",
    () => ({}),
  );
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // A draft created by an older renderer may contain a value whose schema now
  // marks it secret. Scrub that legacy copy as soon as the card mounts; current
  // secret edits never enter the draft store in the first place.
  useEffect(() => {
    const sensitiveKeys = fields
      .filter((field) => field.sensitive)
      .map((field) => field.key);
    if (!sensitiveKeys.some((key) => Object.hasOwn(values, key))) return;
    setValues((previous) => {
      const next = { ...previous };
      for (const key of sensitiveKeys) delete next[key];
      return next;
    });
  }, [fields, setValues, values]);
  const resolvedValues = {
    ...Object.fromEntries(
      Object.entries(values).filter(([key]) =>
        !fields.some((field) => field.key === key && field.sensitive)),
    ),
    ...secretValues,
  };
  const respond = async (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string>,
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(action, content);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BlockingPromptCard
      title="MCP server requested input"
      description={elicitation.message}
      meta={elicitation.mcpServerName}
      expiresAt={elicitation.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label="Claude MCP input request"
      arrivalAnnouncement="Claude is waiting for MCP input."
      className="mb-3"
    >
      <div className="px-3 py-3">
      <div className="text-sm font-medium mb-1">{elicitation.mcpServerName}</div>
      {elicitation.url && (
        <div className="mb-3 text-xs font-mono break-all rounded border border-border bg-background/60 px-2 py-1.5">
          {elicitation.url}
        </div>
      )}
      {fields.length > 0 && (
        <div className="space-y-2 mb-3">
          {fields.map((field) => (
            <label key={field.key} className="block text-xs">
              <span className="mb-1 block text-muted-foreground">{field.label}</span>
              <input
                value={(field.sensitive ? secretValues : values)[field.key] ?? ""}
                onChange={(e) => {
                  const setter = field.sensitive ? setSecretValues : setValues;
                  setter((prev) => ({ ...prev, [field.key]: e.target.value }));
                }}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none"
                type={field.sensitive ? "password" : "text"}
              />
              {field.sensitive && (
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Secret input stays only in this card and is lost if you leave it.
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void respond("cancel")} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" onClick={() => void respond("decline")} disabled={submitting}>
          Decline
        </Button>
        <Button size="sm" onClick={() => void respond("accept", resolvedValues)} disabled={submitting}>
          Submit
        </Button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

// ─── In-TUI selection prompt controls ───────────────────────────────────────

export function pendingSnapshotFromHooks(
  hooks: TmuxPendingHook[],
  infoEvents?: TmuxInfoEvent[],
) {
  const approvals: TmuxPendingApproval[] = [];
  const questions: TmuxPendingQuestion[] = [];
  const plans: TmuxPendingPlan[] = [];
  const permissions: TmuxPendingPermission[] = [];
  const elicitations: TmuxPendingElicitation[] = [];

  for (const hook of hooks) {
    const timing = hookTiming(hook);
    if (hook.kind === "PreToolUse") {
      const toolName = hookToolName(hook.payload);
      if (toolName === "AskUserQuestion") {
        questions.push(payloadToQuestion(hook.id, hook.payload, timing));
      } else if (toolName === "ExitPlanMode") {
        plans.push(payloadToPlan(hook.id, hook.payload, timing));
      } else {
        approvals.push(payloadToApproval(hook.id, hook.payload, timing));
      }
    } else if (hook.kind === "PermissionRequest") {
      permissions.push(payloadToPermission(hook.id, hook.payload, timing));
    } else if (hook.kind === "Elicitation") {
      elicitations.push(payloadToElicitation(hook.id, hook.payload, timing));
    }
  }

  return { approvals, questions, plans, permissions, elicitations, infoEvents };
}

export function hookTiming(hook: TmuxPendingHook): {
  requestedAt?: number;
  expiresAt?: number;
} {
  return {
    ...(hook.requestedAt !== undefined ? { requestedAt: hook.requestedAt } : {}),
    ...(hook.expiresAt !== undefined ? { expiresAt: hook.expiresAt } : {}),
  };
}

export function shouldAutoAllowPermissionHook(hook: TmuxPendingHook): boolean {
  return hook.kind === "PermissionRequest" && isQuestionPermissionPayload(hook.payload);
}

export function isQuestionPermissionPayload(payload: unknown): boolean {
  return hookToolName(payload) === "AskUserQuestion";
}

export async function autoAllowPermissionHook(
  tabId: string,
  environmentId: string,
  eventId: string,
  payload: unknown,
): Promise<void> {
  const permission = payloadToPermission(eventId, payload);
  await replyHook(
    tabId,
    "PermissionRequest",
    eventId,
    permissionRequestResponse(permission, true),
    environmentId,
  );
}

export function selectionPromptToQuestion(
  prompt: TmuxSelectionPrompt,
  tabId: string,
) {
  return {
    id: selectionPromptKey(prompt),
    sessionId: tabId,
    toolUseId: selectionPromptKey(prompt),
    questions: [
      {
        question: prompt.question ?? "Choose an option",
        header: "Claude is asking for a choice",
        options: prompt.options.map((option) => ({
          label: option.label,
          value: selectionPromptOptionValue(option),
        })),
        multiSelect: false,
      },
    ],
  };
}

export function selectionPromptInitialAnswer(prompt: TmuxSelectionPrompt): string[] {
  const selected = prompt.selectedOptionIndex === null
    ? undefined
    : prompt.options[prompt.selectedOptionIndex];
  return selected ? [selectionPromptOptionValue(selected)] : [];
}

export function selectionPromptOptionValue(option: TmuxSelectionOption): string {
  return `${option.optionIndex}:${option.number}:${option.label}`;
}

export function selectionPromptKey(prompt: TmuxSelectionPrompt): string {
  return [
    "tmux-selection",
    prompt.inputMode,
    prompt.selectedOptionIndex,
    prompt.question ?? "",
    ...prompt.options.map((option) => `${option.number}:${option.label}`),
  ].join("|");
}

export function hookToolName(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const value = p.tool_name ?? p.toolName;
  return typeof value === "string" ? value : null;
}

export function questionAnswersToRecord(
  questions: TmuxPendingQuestion["questions"],
  answers: string[][],
): Record<string, string> {
  const mapped: Record<string, string> = {};
  questions.forEach((question, index) => {
    mapped[question.question] = serializeClaudeQuestionAnswer(
      answers[index] ?? [],
      question.multiSelect === true,
    );
  });
  return mapped;
}

export function preToolAllow(updatedInput: Record<string, unknown>) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

export function preToolDeny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function permissionRequestResponse(
  permission: TmuxPendingPermission,
  allow: boolean,
  updatedPermissions?: unknown[],
) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: allow
        ? {
            behavior: "allow",
            updatedInput: permission.toolInput,
            ...(updatedPermissions ? { updatedPermissions } : {}),
          }
        : {
            behavior: "deny",
            message: "Permission denied by user.",
          },
    },
  };
}

export function elicitationResponse(
  action: "accept" | "decline" | "cancel",
  content?: Record<string, string>,
) {
  return {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action,
      ...(action === "accept" ? { content: content ?? {} } : {}),
    },
  };
}

export function elicitationSchemaFields(schema: Record<string, unknown> | null): Array<{
  key: string;
  label: string;
  sensitive: boolean;
}> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties as Record<string, unknown>).map(([key, raw]) => {
    const field = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const title = typeof field.title === "string" ? field.title : key;
    const format = typeof field.format === "string" ? field.format : "";
    const sensitiveMarker = `${key} ${title} ${format}`;
    return {
      key,
      label: title,
      sensitive:
        field.writeOnly === true
        || field.sensitive === true
        || /password|passphrase|secret|token|credential|api[\s_-]*key|private[\s_-]*key/i
          .test(sensitiveMarker),
    };
  });
}

export function tmuxFileMentionPath(
  relativePath: string,
  containerId?: string,
  worktreePath?: string,
): string | null {
  if (relativePath.startsWith("/")) {
    return escapePathForTerminalInput(relativePath);
  }

  const normalizedPath = relativePath.replace(/^\/+/, "");
  if (!normalizedPath) return null;

  const basePath = containerId
    ? "/workspace"
    : worktreePath?.replace(/\/+$/, "");
  if (!basePath) return normalizedPath;

  return escapePathForTerminalInput(`${basePath}/${normalizedPath}`);
}

export function serializeTmuxFileMentions(
  text: string,
  mentions: FileMention[],
  containerId?: string,
  worktreePath?: string,
): string {
  if (!text.includes("@") || mentions.length === 0) return text;

  let result = text;
  const sortedMentions = [...mentions].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  );

  for (const mention of sortedMentions) {
    const mentionPath = tmuxFileMentionPath(
      mention.relativePath,
      containerId,
      worktreePath,
    );
    if (!mentionPath) continue;
    result = result.replace(
      new RegExp(`@${escapeRegExp(mention.relativePath)}(?=\\s|$)`, "g"),
      mentionPath,
    );
  }

  return result;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Compose bar ─────────────────────────────────────────────────────────────

export const EMPTY_TMUX_ATTACHMENTS: TmuxAttachment[] = [];
export const EMPTY_TMUX_MENTIONS: FileMention[] = [];
export const EMPTY_TMUX_QUEUE: TmuxQueuedMessage[] = [];

export interface TmuxComposeBarProps {
  sessionKey: string;
  environmentId: string;
  containerId?: string;
  worktreePath?: string;
  disabled: boolean;
  busy: boolean;
  submitting: boolean;
  autoFocus?: boolean;
  onSubmit: (text: string, attachments: TmuxAttachment[]) => Promise<boolean> | boolean | void;
  onQueue?: (text: string, attachments: TmuxAttachment[]) => Promise<void> | void;
  onQueueError?: (message: string) => void;
  queueLength?: number;
  showAddressAll?: boolean;
  onAddressAll?: () => void;
  onInterrupt: () => void;
  models: ClaudeModel[];
  selectedModel: string;
  onSelectModel: (id: string) => void;
  selectedEffort: ClaudeEffortLevel;
  effortOptions: ClaudeEffortLevel[];
  onSelectEffort: (level: ClaudeEffortLevel) => void;
  fastModeEnabled: boolean | null;
  fastModeAvailable: boolean;
  onSelectFastMode: (enabled: boolean) => void;
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
  modelDisabled: boolean;
  modelSwitching: boolean;
  effortSwitching: boolean;
  planLocked: boolean;
  layout?: "bottom" | "centered";
}

export function TmuxComposeBar({
  sessionKey,
  environmentId,
  containerId,
  worktreePath,
  disabled,
  busy,
  submitting,
  autoFocus,
  onSubmit,
  onQueue,
  onQueueError,
  queueLength = 0,
  showAddressAll = false,
  onAddressAll,
  onInterrupt,
  models,
  selectedModel,
  onSelectModel,
  selectedEffort,
  effortOptions,
  onSelectEffort,
  fastModeEnabled,
  fastModeAvailable,
  onSelectFastMode,
  planMode,
  onTogglePlanMode,
  modelDisabled,
  modelSwitching,
  effortSwitching,
  planLocked,
  layout = "bottom",
}: TmuxComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const pendingCursorPositionRef = useRef<number | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [queueSubmitting, setQueueSubmitting] = useState(false);
  const queueSubmittingRef = useRef(false);
  const value = useClaudeTmuxStore((state) => state.draftText.get(sessionKey) ?? "");
  const fileMentions = useClaudeTmuxStore(
    useCallback(
      (state) => state.draftMentions.get(sessionKey) ?? EMPTY_TMUX_MENTIONS,
      [sessionKey],
    ),
  );
  const attachments = useClaudeTmuxStore(
    useCallback(
      (state) => state.attachments.get(sessionKey) ?? EMPTY_TMUX_ATTACHMENTS,
      [sessionKey],
    ),
  );
  const queuedMessages = useClaudeTmuxStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey) ?? EMPTY_TMUX_QUEUE,
      [sessionKey],
    ),
  );
  const queueRecovery = usePromptQueueDispatchRecovery("claude-tmux", sessionKey);
  const setValue = useClaudeTmuxStore((state) => state.setDraftText);
  const setFileMentions = useClaudeTmuxStore((state) => state.setDraftMentions);
  const addAttachmentToStore = useClaudeTmuxStore((state) => state.addAttachment);
  const removeAttachmentFromStore = useClaudeTmuxStore((state) => state.removeAttachment);
  const clearAttachments = useClaudeTmuxStore((state) => state.clearAttachments);
  useNativeComposeDraftPersistence(
    "claude-tmux",
    environmentId,
    sessionKey,
    useClaudeTmuxStore,
  );
  const modelObj = useMemo(
    () => getTmuxModel(selectedModel, models),
    [selectedModel, models],
  );

  // Slash command menu state. The list is static (claude builtins) — see
  // TMUX_BUILTIN_SLASH_COMMANDS at the top of the file.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } =
    useFileSearch(containerId, worktreePath, false);
  const {
    isMenuOpen: fileMentionMenuOpen,
    selectedIndex: fileMentionSelectedIndex,
    filteredFiles,
    handleCursorChange: detectFileMention,
    handleKeyDown: handleFileMentionKeyDown,
    closeMenu: closeFileMentionMenu,
  } = useFileMentions({ searchFiles });

  const filteredSlashCommands = useMemo(() => {
    if (!value.startsWith("/")) return [];
    // Filter on everything between "/" and the first space (or end).
    const spaceIdx = value.indexOf(" ");
    const filter = (spaceIdx === -1 ? value.slice(1) : value.slice(1, spaceIdx))
      .toLowerCase();
    return TMUX_BUILTIN_SLASH_COMMANDS.filter((cmd) =>
      cmd.name.slice(1).toLowerCase().includes(filter),
    );
  }, [value]);

  // Open/close the menu based on whether the input *currently* looks like
  // the start of a slash command (no space yet → still typing the command
  // name; space typed → user has moved on to arguments, hide the menu).
  useEffect(() => {
    if (fileMentionMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [fileMentionMenuOpen]);

  useEffect(() => {
    if (fileSearchError) {
      console.debug("[ClaudeTmuxChatTab] Failed to load files for @mentions", fileSearchError);
    }
  }, [fileSearchError]);

  useEffect(() => {
    const wasOpen = prevFileMentionMenuOpen.current;
    prevFileMentionMenuOpen.current = fileMentionMenuOpen;
    if (!wasOpen && fileMentionMenuOpen) {
      refreshFileTree();
    }
  }, [fileMentionMenuOpen, refreshFileTree]);

  useLayoutEffect(() => {
    const cursorPosition = pendingCursorPositionRef.current;
    const textarea = textareaRef.current;
    if (cursorPosition === null || !textarea) return;

    textarea.focus();
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    pendingCursorPositionRef.current = null;
  }, [value]);

  useEffect(() => {
    if (!value.startsWith("/")) {
      setSlashMenuOpen(false);
      return;
    }
    const hasSpace = value.indexOf(" ") !== -1;
    if (hasSpace) {
      setSlashMenuOpen(false);
      return;
    }
    setSlashMenuOpen(true);
    setSlashSelectedIndex((prev) =>
      prev < filteredSlashCommands.length ? prev : 0,
    );
  }, [value, filteredSlashCommands.length]);

  // Auto-grow textarea, bounded.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [value]);

  const selectSlashCommand = (command: SlashCommand) => {
    // Drop the user back in the input after the command + a space so they
    // can type any arguments (e.g. `/model opus`) before pressing Enter.
    setValue(sessionKey, command.name + " ");
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  };

  const updateFileMentionDetection = (position: number, currentValue: string) => {
    detectFileMention(position, currentValue);
  };

  const selectFileMention = (file: FileCandidate) => {
    const textarea = textareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPosition);
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
    const atStart = atMatch ? textBeforeCursor.length - atMatch[0].length : cursorPosition;
    const insertedText = `@${file.relativePath} `;
    const nextValue =
      value.slice(0, atStart) + insertedText + value.slice(cursorPosition);

    pendingCursorPositionRef.current = atStart + insertedText.length;
    setValue(sessionKey, nextValue);
    const nextMentions = (() => {
      const current = useClaudeTmuxStore.getState().getDraftMentions(sessionKey);
      if (current.some((mention) => mention.relativePath === file.relativePath)) {
        return current;
      }
      return [
        ...current,
        {
          id: createUuid(),
          filename: file.filename,
          relativePath: file.relativePath,
        },
      ];
    })();
    setFileMentions(sessionKey, nextMentions);
    closeFileMentionMenu();
  };

  const addAttachment = useCallback((attachment: PastedImageAttachment) => {
    addAttachmentToStore(sessionKey, attachment);
  }, [addAttachmentToStore, sessionKey]);

  const removeAttachment = useCallback((id: string) => {
    removeAttachmentFromStore(sessionKey, id);
  }, [removeAttachmentFromStore, sessionKey]);

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: addAttachment,
    logLabel: "ClaudeTmuxComposeBar",
  });

  const handleSubmit = async () => {
    if (submitting || queueSubmittingRef.current || disabled) return;
    const serializedText = serializeTmuxFileMentions(
      value.trim(),
      fileMentions,
      containerId,
      worktreePath,
    );
    if (!serializedText && attachments.length === 0) return;

    if (busy) {
      if (!onQueue) return;
      queueSubmittingRef.current = true;
      setQueueSubmitting(true);
      try {
        await onQueue(serializedText, attachments);
        setValue(sessionKey, "");
        setFileMentions(sessionKey, []);
        clearAttachments(sessionKey);
      } catch {
        // The parent reports the backend error. Keep the draft intact so the
        // user can retry without reconstructing the prompt or attachments.
      } finally {
        queueSubmittingRef.current = false;
        setQueueSubmitting(false);
      }
      return;
    }

    const result = await onSubmit(serializedText, attachments);
    if (result !== false) {
      setValue(sessionKey, "");
      setFileMentions(sessionKey, []);
      clearAttachments(sessionKey);
    }
  };

  const handleQueuedMessageClick = useCallback(
    async (message: TmuxQueuedMessage) => {
      // Editing loads the prompt into the composer, so anything already there
      // would be destroyed. This used to return silently, which read as the
      // click simply not working.
      if (value.trim() || attachments.length > 0) {
        throw composerOccupiedError();
      }
      try {
        const removed = await removeAgentPrompt<TmuxQueuedMessage>(
          "claude-tmux",
          sessionKey,
          message.id,
        );
        if (!removed) return;
        setValue(sessionKey, removed.text);
        setFileMentions(sessionKey, []);
        clearAttachments(sessionKey);
        for (const attachment of removed.attachments) {
          addAttachmentToStore(sessionKey, attachment);
        }
        setQueueDialogOpen(false);
      } catch (error) {
        onQueueError?.(
          `Failed to edit queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    },
    [
      addAttachmentToStore,
      attachments.length,
      clearAttachments,
      onQueueError,
      sessionKey,
      setFileMentions,
      setValue,
      value,
    ],
  );

  const handleMoveQueuedMessage = useCallback(
    async (fromIndex: number, toIndex: number) => {
      const message = queuedMessages[fromIndex];
      if (!message || Math.abs(toIndex - fromIndex) !== 1) return;
      try {
        await moveAgentPrompt(
          "claude-tmux",
          sessionKey,
          message.id,
          toIndex < fromIndex ? "up" : "down",
        );
      } catch (error) {
        onQueueError?.(
          `Failed to move queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    },
    [onQueueError, queuedMessages, sessionKey],
  );

  const handleRemoveQueuedMessage = useCallback(
    async (messageId: string) => {
      try {
        await removeAgentPrompt("claude-tmux", sessionKey, messageId);
      } catch (error) {
        onQueueError?.(
          `Failed to remove queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    },
    [onQueueError, sessionKey],
  );

  return (
    <div
      className={cn(
        "mx-auto w-[calc(100%_-_0.75rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]",
        layout === "bottom" ? "mb-4 mt-2" : "my-0",
      )}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="relative group flex items-center gap-1.5 px-2 py-1 rounded bg-muted/50 border border-border text-xs"
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.name}
                className="w-6 h-6 object-cover rounded"
              />
              <span className="max-w-[120px] truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="ml-1 p-0.5 rounded-full hover:bg-muted"
                title="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative" ref={inputContainerRef}>
        {fileMentionMenuOpen && (
          <FileMentionMenu
            files={filteredFiles}
            selectedIndex={fileMentionSelectedIndex}
            onSelect={selectFileMention}
            onClose={closeFileMentionMenu}
          />
        )}

        {slashMenuOpen && filteredSlashCommands.length > 0 && (
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={selectSlashCommand}
            onClose={() => setSlashMenuOpen(false)}
          />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            const nextValue = e.target.value;
            setValue(sessionKey, nextValue);
            const currentMentions = useClaudeTmuxStore
              .getState()
              .getDraftMentions(sessionKey);
            setFileMentions(
              sessionKey,
              currentMentions.filter((mention) =>
                nextValue.includes(`@${mention.relativePath}`),
              ),
            );
            updateFileMentionDetection(e.target.selectionStart, nextValue);
          }}
          onClick={(e) => {
            updateFileMentionDetection(e.currentTarget.selectionStart, e.currentTarget.value);
          }}
          onKeyUp={(e) => {
            if (
              e.key === "ArrowLeft" ||
              e.key === "ArrowRight" ||
              e.key === "Home" ||
              e.key === "End" ||
              e.key === "Backspace" ||
              e.key === "Delete"
            ) {
              updateFileMentionDetection(e.currentTarget.selectionStart, e.currentTarget.value);
            }
          }}
          onKeyDown={(e) => {
            if (fileMentionMenuOpen) {
              const handled = handleFileMentionKeyDown(e, selectFileMention);
              if (handled) return;
            }

            // Slash-command menu takes keyboard priority while open.
            if (slashMenuOpen && filteredSlashCommands.length > 0) {
              switch (e.key) {
                case "ArrowDown":
                  e.preventDefault();
                  setSlashSelectedIndex((prev) =>
                    prev < filteredSlashCommands.length - 1 ? prev + 1 : prev,
                  );
                  return;
                case "ArrowUp":
                  e.preventDefault();
                  setSlashSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
                  return;
                case "Tab": {
                  const cmd = filteredSlashCommands[slashSelectedIndex];
                  if (cmd) {
                    e.preventDefault();
                    selectSlashCommand(cmd);
                  }
                  return;
                }
                case "Enter": {
                  // Enter selects the highlighted command (no submit yet —
                  // user may want to add arguments before sending).
                  if (e.shiftKey || e.metaKey || e.ctrlKey) break;
                  const cmd = filteredSlashCommands[slashSelectedIndex];
                  if (cmd) {
                    e.preventDefault();
                    selectSlashCommand(cmd);
                    return;
                  }
                  break;
                }
                case "Escape":
                  e.preventDefault();
                  setSlashMenuOpen(false);
                  return;
              }
            }

            // Enter submits; Shift+Enter (and Cmd/Ctrl+Enter, for muscle
            // memory) inserts a newline.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey
            ) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={
            disabled
              ? "Session not running"
              : "Ask Claude anything… (@ to mention, / for commands)"
          }
          disabled={disabled || submitting || queueSubmitting}
          rows={2}
          autoFocus={autoFocus && !isMobile}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-5",
            "px-1 py-1 focus:outline-none placeholder:text-muted-foreground/60",
            "disabled:opacity-60",
          )}
          style={{ minHeight: 28, maxHeight: 12 * 20 + 16 }}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          disabled
          className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed"
          title="Paste an image into the input to attach it"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* The combined picker is selectable before launch and sends the same
            model/effort commands to the running tmux pane after launch. */}
        <AgentModelPicker
          models={models.map((model) => ({
            id: model.id,
            platform: "claude",
            label: model.name,
            description: model.description,
          }))}
          selectedModelId={selectedModel}
          selectedModelLabel={modelObj.name}
          onModelChange={onSelectModel}
          reasoningOptions={effortOptions.map((level) => ({
            id: level,
            label: EFFORT_LABELS[level],
            description: EFFORT_DESCRIPTIONS[level],
            annotation: level === DEFAULT_EFFORT ? "default" : undefined,
          }))}
          selectedReasoningId={selectedEffort}
          selectedReasoningLabel={effortOptions.length > 0 ? EFFORT_LABELS[selectedEffort] : undefined}
          onReasoningChange={(level) => onSelectEffort(level as ClaudeEffortLevel)}
          fastModeEnabled={fastModeEnabled}
          fastModeAvailable={fastModeAvailable}
          onFastModeChange={onSelectFastMode}
          disabled={modelDisabled}
          title={
            modelSwitching
              ? "Switching Claude model"
              : effortSwitching
                ? "Switching effort level"
                : modelDisabled
                  ? "Wait for Claude to finish before changing model settings"
                  : disabled
                    ? "Select model settings for the next tmux launch"
                    : "Switch model settings for this tmux session"
          }
        />

        {/* Plan / Build mode */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={planLocked}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-60"
              title={
                planLocked
                  ? "Wait for the Claude session to be idle before changing modes"
                  : "Switch the running Claude session between build and plan mode"
              }
            >
              <ChevronDown className="w-3 h-3" />
              <span>{planMode ? "Plan" : "Build"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onTogglePlanMode(false)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {!planMode && <Check className="w-4 h-4 text-primary" />}
              </div>
              Build
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTogglePlanMode(true)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {planMode && <Check className="w-4 h-4 text-primary" />}
              </div>
              Plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        {showAddressAll && !busy && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onAddressAll?.()}
            disabled={disabled || submitting}
            className="h-7 rounded-full px-3 text-xs"
            title="Send the review follow-up prompt"
          >
            Address all
          </Button>
        )}

        {queueLength > 0 && (
          <button
            type="button"
            onClick={() => setQueueDialogOpen(true)}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
              queueRecovery.dispatchError
                ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                : "text-muted-foreground bg-muted/50 hover:bg-muted",
            )}
            aria-label={
              queueRecovery.dispatchError
                ? `${queueLength} queued prompts blocked: ${queueRecovery.dispatchError.message}`
                : undefined
            }
            title={
              queueRecovery.dispatchError
                ? `Queued prompt was not sent: ${queueRecovery.dispatchError.message}`
                : "View queued prompts"
            }
          >
            {queueRecovery.dispatchError && (
              <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span>+{queueLength} queued</span>
          </button>
        )}

        {/* Send / Stop button */}
        <Button
          size="sm"
          onClick={busy && !value.trim() && attachments.length === 0 ? onInterrupt : handleSubmit}
          disabled={
            disabled ||
            submitting ||
            queueSubmitting ||
            (!busy && !value.trim() && attachments.length === 0)
          }
          className="h-7 w-7 p-0 rounded-full"
          title={
            busy
              ? value.trim() || attachments.length > 0
                ? "Add to queue"
                : "Interrupt current response"
              : "Send (↵)"
          }
        >
          {busy && !value.trim() && attachments.length === 0 ? (
            <Square className="w-3.5 h-3.5" />
          ) : (
            <ArrowUp className="w-4 h-4" />
          )}
        </Button>
      </div>

      <QueuedPromptsDialog
        open={queueDialogOpen}
        onOpenChange={setQueueDialogOpen}
        messages={queuedMessages}
        onEdit={handleQueuedMessageClick}
        onMove={handleMoveQueuedMessage}
        onRemove={handleRemoveQueuedMessage}
        dispatchError={queueRecovery.dispatchError}
        onRetryDispatch={queueRecovery.retry}
        renderMeta={(message) => (
          message.attachments.length > 0 ? (
            <span>
              {message.attachments.length} attachment
              {message.attachments.length === 1 ? "" : "s"}
            </span>
          ) : null
        )}
      />
    </div>
  );
}

// ─── Approval card (only fires when claude permission flow somehow surfaces) ─

export function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: {
    eventId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    expiresAt?: number;
  };
  onApprove: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (action: () => Promise<void> | void) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await action();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <BlockingPromptCard
      title="Claude wants to use a tool"
      expiresAt={approval.expiresAt}
      state={submitting ? "submitting" : "pending"}
      aria-label={`Claude wants to use ${approval.toolName}`}
      arrivalAnnouncement="Claude is waiting for a tool decision."
      className="mb-3"
    >
      <div className="px-3 py-3">
      <div className="text-sm font-mono text-amber-200 mb-2">
        {approval.toolName}
      </div>
      <ApprovalToolInput
        toolName={approval.toolName}
        toolInput={approval.toolInput}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void respond(onApprove)}
          disabled={submitting}
          className="flex-1 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => void respond(onDeny)}
          disabled={submitting}
          className="flex-1 px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white text-sm font-medium"
        >
          Deny
        </button>
      </div>
      </div>
    </BlockingPromptCard>
  );
}

/**
 * Renders tool input as labeled fields rather than raw JSON. We special-case
 * the common Claude tools (Bash, Edit, Write, Read) since their args have
 * conventional shapes; unknown tools fall back to a key/value table.
 */
export function ApprovalToolInput({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  const command =
    typeof toolInput.command === "string" ? toolInput.command : null;
  const description =
    typeof toolInput.description === "string" ? toolInput.description : null;
  const filePath =
    typeof toolInput.file_path === "string" ? toolInput.file_path : null;

  // Bash → command + optional description.
  if (toolName === "Bash" && command) {
    return (
      <div className="mb-3 space-y-2">
        {description && (
          <div className="text-xs text-amber-100/80">{description}</div>
        )}
        <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono">
          $ {command}
        </pre>
      </div>
    );
  }

  // File-oriented tools → show path + a short content preview if present.
  if (filePath) {
    const preview =
      (typeof toolInput.new_string === "string" && toolInput.new_string) ||
      (typeof toolInput.content === "string" && toolInput.content) ||
      null;
    return (
      <div className="mb-3 space-y-2">
        <div className="text-xs font-mono text-amber-100/90 break-all">
          {filePath}
        </div>
        {preview && (
          <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono max-h-40 overflow-auto">
            {preview}
          </pre>
        )}
      </div>
    );
  }

  // Fallback: render keys/values without dumping a single blob of JSON.
  const entries = Object.entries(toolInput);
  if (entries.length === 0) {
    return <div className="mb-3 text-xs text-muted-foreground">(no args)</div>;
  }
  return (
    <div className="mb-3 space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="text-xs">
          <span className="font-mono text-amber-300/80">{key}:</span>{" "}
          <span className="font-mono text-amber-100/90 break-all whitespace-pre-wrap">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </div>
      ))}
    </div>
  );
}


