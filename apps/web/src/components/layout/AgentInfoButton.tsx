import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  ArrowRightLeft,
  Copy,
  Info,
  RotateCcw,
  Scissors,
  Share2,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn, createSessionKey } from "@/lib/utils";
import type {
  AgentRateLimitWindow,
  ContextUsageSnapshot,
} from "@/lib/context-usage";
import { formatTokenCount } from "@/lib/context-usage";
import type { TabInfo } from "@/types/paneLayout";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import {
  compactClaudeSession,
  forkClaudeSession,
  getSession as getClaudeSession,
  getSessionMessages as getClaudeSessionMessages,
  rewindClaudeFiles,
  stopClaudeBackgroundTask,
} from "@/lib/claude-client";
import {
  compactOpenCodeSession,
  forkOpenCodeSession,
  getSessionMessages as getOpenCodeSessionMessages,
  getSessionStatus as getOpenCodeSessionStatus,
  revertOpenCodeSession,
  shareOpenCodeSession,
  unrevertOpenCodeSession,
  unshareOpenCodeSession,
} from "@/lib/opencode-client";
import {
  CodexForkError,
  compactCodexSession,
  forkCodexSession,
  getCodexRuntimeHealth,
  getSessionMessages as getCodexSessionMessages,
  getSessionStatus as getCodexSessionStatus,
  startCodexNativeReview,
  steerCodexSession,
} from "@/lib/codex-client";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUuid } from "@/lib/uuid";
import {
  AGENT_PROVIDER_LABELS,
  agentHandoffTranscriptDigest,
  composeAgentHandoffTransferMessages,
  createAgentHandoffSnapshot,
  forgetAgentHandoff,
  loadAgentHandoff,
  persistAgentHandoff,
  type AgentProvider,
} from "@/lib/agent-handoff";
import { deleteAgentHandoff } from "@/lib/backend";
import {
  normalizeClaudeMessagesForDisplay,
  normalizeCodexNativeMessage,
  normalizeOpenCodeNativeMessage,
} from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";

interface AgentInfoButtonProps {
  activeTab: TabInfo | null;
  mobile?: boolean;
}

interface SessionActionState {
  actionId: number;
  name: string;
  sessionIdentity: string;
}

interface SessionValueState<T> {
  sessionIdentity: string | null;
  value: T;
}

const EMPTY_CLAUDE_TASKS: Record<string, never> = {};

interface ActiveNativeSession {
  provider: "claude" | "opencode" | "codex";
  providerLabel: string;
  environmentId: string;
  sessionKey: string;
}

function resolveActiveNativeSession(tab: TabInfo | null): ActiveNativeSession | null {
  if (tab?.type === "claude-native" && tab.claudeNativeData) {
    const environmentId = tab.claudeNativeData.environmentId;
    return {
      provider: "claude",
      providerLabel: "Claude Native",
      environmentId,
      sessionKey: createSessionKey(environmentId, tab.id),
    };
  }
  if (tab?.type === "opencode-native" && tab.openCodeNativeData) {
    const environmentId = tab.openCodeNativeData.environmentId;
    return {
      provider: "opencode",
      providerLabel: "OpenCode",
      environmentId,
      sessionKey: createSessionKey(environmentId, tab.id),
    };
  }
  if (tab?.type === "codex-native" && tab.codexNativeData) {
    const environmentId = tab.codexNativeData.environmentId;
    return {
      provider: "codex",
      providerLabel: "Codex Native",
      environmentId,
      sessionKey: createSessionKey(environmentId, tab.id),
    };
  }
  return null;
}

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatCount(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function formatResetDateTime(value: string): string {
  const resetDate = new Date(value);
  const weekday = resetDate.toLocaleDateString(undefined, { weekday: "long" });
  return `${weekday}, ${resetDate.toLocaleString()}`;
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-sm tabular-nums text-foreground">
        {value}
      </div>
      {detail ? (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function inventoryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const data = record(value).data;
  if (Array.isArray(data)) {
    return data.reduce((count, entry) => {
      const item = record(entry);
      const nested = item.skills ?? item.hooks ?? item.servers;
      return count + (Array.isArray(nested) ? nested.length : 1);
    }, 0);
  }
  return Object.keys(record(value)).filter((key) => key !== "error").length;
}

/**
 * Read the authoritative share state for an OpenCode session.
 *
 * The store's session record carries no share field, so the server's own
 * session document is the only snapshot that survives a tab switch or an app
 * restart. Probed structurally rather than against the SDK types so a partial
 * client (older server, test double) reports "not shared" instead of throwing.
 *
 * Follow-up for the lib owner: this belongs in `opencode-client.ts` as a typed
 * `getOpenCodeShareUrl(client, sessionId)`.
 */
async function readOpenCodeShareUrl(
  client: unknown,
  sessionId: string,
): Promise<string | null> {
  const sessions = record(client).session;
  const get = record(sessions).get;
  if (typeof get !== "function") return null;
  const response = await (get as (parameters: { sessionID: string }) => Promise<unknown>)
    .call(sessions, { sessionID: sessionId });
  const url = record(record(record(response).data).share).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Turn the opaque rewind dry-run payload into something a person can act on.
 *
 * `rewindClaudeFiles` returns `unknown` — it is whatever the installed Agent
 * SDK hands back — so every shape is probed defensively and anything
 * unrecognised degrades to "no files reported" rather than to raw JSON. The
 * previous confirm dialog pasted `JSON.stringify(...).slice(0, 800)` into a
 * `window.confirm`, which truncated mid-structure and asked the user to approve
 * a destructive worktree mutation they could not read.
 */
export function summarizeRewindPreview(preview: unknown): {
  files: string[];
  fileCount: number;
} {
  const root = record(preview);
  const candidates = [
    root.files,
    root.restoredFiles,
    root.changedFiles,
    root.filesRestored,
    root.filesChanged,
    record(root.preview).files,
  ];
  const list = candidates.find((value): value is unknown[] => Array.isArray(value)) ?? [];
  const files = list.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const item = record(entry);
    for (const key of ["path", "file", "filePath", "name"]) {
      const value = item[key];
      if (typeof value === "string" && value.length > 0) return [value];
    }
    return [];
  });
  const reportedCount = [root.fileCount, root.count, root.totalFiles].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return {
    files,
    fileCount: files.length > 0 ? files.length : reportedCount ?? 0,
  };
}

/** One short line naming the message a destructive action is anchored to. */
export function describeRewindTarget(text: string | undefined): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "your most recent message";
  return normalized.length > 80
    ? `“${normalized.slice(0, 80)}…”`
    : `“${normalized}”`;
}

function codexLimitsFromHealth(health: unknown): {
  rateLimits: NonNullable<ContextUsageSnapshot["rateLimits"]>;
  credits?: NonNullable<ContextUsageSnapshot["credits"]>;
} {
  const response = record(record(health).rateLimits);
  const snapshot = record(response.rateLimits);
  const rateLimits: NonNullable<ContextUsageSnapshot["rateLimits"]> = [];
  for (const [key, fallback] of [["primary", "Primary"], ["secondary", "Secondary"]] as const) {
    const window = record(snapshot[key]);
    if (Object.keys(window).length === 0) continue;
    const reset = typeof window.resetsAt === "number" ? window.resetsAt : undefined;
    rateLimits.push({
      label: typeof snapshot.limitName === "string" && key === "primary"
        ? snapshot.limitName
        : fallback,
      usedPercent: typeof window.usedPercent === "number"
        ? window.usedPercent
        : undefined,
      ...(reset !== undefined
        ? { resetsAt: new Date(reset * 1_000).toISOString() }
        : {}),
    });
  }
  const rawCredits = record(snapshot.credits);
  const credits = Object.keys(rawCredits).length > 0
    ? {
        ...(typeof rawCredits.balance === "string" ? { balance: rawCredits.balance } : {}),
        ...(typeof rawCredits.hasCredits === "boolean"
          ? { hasCredits: rawCredits.hasCredits }
          : {}),
        ...(typeof rawCredits.unlimited === "boolean"
          ? { unlimited: rawCredits.unlimited }
          : {}),
      }
    : undefined;
  return {
    rateLimits,
    ...(credits ? { credits } : {}),
  };
}

function CodexRuntimePanel({ health }: { health: unknown }) {
  if (!health) {
    return <div className="text-xs text-muted-foreground">Loading Codex runtime…</div>;
  }
  const snapshot = record(health);
  const engine = record(snapshot.engine);
  const notices = Array.isArray(snapshot.notices)
    ? snapshot.notices.flatMap((notice) => {
        const item = record(notice);
        return typeof item.message === "string" ? [item] : [];
      })
    : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Metric label="MCP" value={String(inventoryCount(snapshot.mcp))} />
        <Metric label="Skills" value={String(inventoryCount(snapshot.skills))} />
        <Metric label="Hooks" value={String(inventoryCount(snapshot.hooks))} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span>{typeof engine.state === "string" ? engine.state : "state unavailable"}</span>
        <span>{typeof engine.codexVersion === "string"
          ? `Codex ${engine.codexVersion}`
          : "version unavailable"}</span>
      </div>
      {notices.length > 0 ? (
        <div className="space-y-1.5">
          {notices.slice(-5).map((notice, index) => (
            <div
              key={`${String(notice.method)}-${index}`}
              className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-100/80"
            >
              {String(notice.message)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UsagePanel({
  usage,
  modelId,
  rateLimits,
}: {
  usage: ContextUsageSnapshot | undefined;
  modelId: string | undefined;
  /** Claude reports these independently of context occupancy. */
  rateLimits?: AgentRateLimitWindow[];
}) {
  const displayedRateLimits = rateLimits ?? usage?.rateLimits;

  if (!usage) {
    if (displayedRateLimits && displayedRateLimits.length > 0) {
      return (
        <div className="space-y-4">
          <RateLimitsSection rateLimits={displayedRateLimits} />
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
            <span className="truncate">{modelId ?? "Model unavailable"}</span>
            <span className="shrink-0">Provider reported</span>
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
        Usage will appear after this session reports its first token snapshot.
      </div>
    );
  }

  const used = Math.max(0, usage.usedTokens);
  const total = Math.max(0, usage.totalTokens);
  const remaining = Math.max(0, total - used);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
              Context
            </div>
            <div className="mt-1 font-mono text-xl tabular-nums text-foreground">
              {usage.percentUsed.toFixed(usage.percentUsed >= 10 ? 0 : 1)}%
            </div>
          </div>
          <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
            <div>{formatTokenCount(used)} / {formatTokenCount(total)}</div>
            <div>{formatTokenCount(remaining)} available</div>
          </div>
        </div>
        <Progress
          value={usage.percentUsed}
          aria-label={`${usage.percentUsed.toFixed(0)} percent of context used`}
          className="h-1.5"
        />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        {usage.inputTokens !== undefined ? (
          <Metric label="Input" value={formatTokenCount(usage.inputTokens)} />
        ) : null}
        {usage.outputTokens !== undefined ? (
          <Metric label="Output" value={formatTokenCount(usage.outputTokens)} />
        ) : null}
        {usage.cacheReadTokens !== undefined ? (
          <Metric label="Cache read" value={formatTokenCount(usage.cacheReadTokens)} />
        ) : null}
        {usage.reasoningTokens !== undefined ? (
          <Metric label="Reasoning" value={formatTokenCount(usage.reasoningTokens)} />
        ) : null}
        {usage.sessionTokens !== undefined ? (
          <Metric label="Session" value={formatTokenCount(usage.sessionTokens)} />
        ) : null}
        {usage.costUsd !== undefined ? (
          <Metric label="Cost" value={formatUsd(usage.costUsd)} />
        ) : null}
        {usage.durationMs !== undefined ? (
          <Metric label="Elapsed" value={formatDuration(usage.durationMs)} />
        ) : null}
        {usage.permissionDenials !== undefined ? (
          <Metric label="Denied" value={String(usage.permissionDenials)} detail="tool permissions" />
        ) : null}
        {usage.credits !== undefined ? (
          <Metric
            label="Credits"
            value={
              usage.credits.unlimited
                ? "Unlimited"
                : usage.credits.balance ?? (usage.credits.hasCredits ? "Available" : "Unavailable")
            }
          />
        ) : null}
      </div>

      {displayedRateLimits && displayedRateLimits.length > 0
        ? <RateLimitsSection rateLimits={displayedRateLimits} />
        : null}

      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
        <span className="truncate">{usage.modelId ?? modelId ?? "Model unavailable"}</span>
        <span className="shrink-0">
          {usage.estimated ? "Estimated" : "Provider reported"}
        </span>
      </div>
    </div>
  );
}

function RateLimitsSection({
  rateLimits,
}: {
  rateLimits: AgentRateLimitWindow[];
}) {
  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        Limits
      </div>
      {rateLimits.map((limit) => (
        <div key={`${limit.label}:${limit.resetsAt ?? ""}`}>
          <div className="mb-1.5 flex justify-between gap-3 text-xs">
            <span className="text-foreground">{limit.label}</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {limit.usedPercent === undefined
                ? "Available"
                : `${limit.usedPercent.toFixed(0)}% used`}
            </span>
          </div>
          {limit.usedPercent !== undefined ? (
            <Progress value={limit.usedPercent} className="h-1" />
          ) : null}
          {limit.resetsAt ? (
            <div className="mt-1 text-right text-[10px] text-muted-foreground">
              Resets {formatResetDateTime(limit.resetsAt)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function AgentInfoButton({
  activeTab,
  mobile = false,
}: AgentInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [busyState, setBusyState] = useState<SessionActionState | null>(null);
  const [codexHealth, setCodexHealth] = useState<unknown>(null);
  const [steerState, setSteerState] = useState<SessionValueState<string>>({
    sessionIdentity: null,
    value: "",
  });
  const [shareState, setShareState] = useState<SessionValueState<boolean>>({
    sessionIdentity: null,
    value: false,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const actionIdRef = useRef(0);
  const shareVersionRef = useRef(0);
  const activeSession = useMemo(
    () => resolveActiveNativeSession(activeTab),
    [activeTab],
  );

  const claudeUsage = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.contextUsage.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeRateLimits = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.rateLimits.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeUsage = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.contextUsage.get(activeSession.sessionKey)
      : undefined,
  );
  const codexUsage = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.contextUsage.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeModel = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.selectedModel.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeModel = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.selectedModel.get(activeSession.environmentId)
      : undefined,
  );
  const codexModel = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.selectedModel.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeClient = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.clients.get(activeSession.environmentId)
      : undefined,
  );
  const openCodeClient = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.clients.get(activeSession.environmentId)
      : undefined,
  );
  const codexClient = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.clients.get(activeSession.environmentId)
      : undefined,
  );
  const claudeSession = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.sessions.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeSession = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.sessions.get(activeSession.sessionKey)
      : undefined,
  );
  const codexSession = useCodexStore((state) =>
    activeSession?.provider === "codex"
      ? state.sessions.get(activeSession.sessionKey)
      : undefined,
  );
  const claudeInit = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.sessionInitData.get(activeSession.environmentId)
      : undefined,
  );
  const claudeAgent = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.selectedAgent.get(activeSession.sessionKey)
      : undefined,
  );
  const includeLocalSettings = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.includeLocalSettings.get(activeSession.sessionKey) ?? false
      : false,
  );
  const promptSuggestionOptIn = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.promptSuggestionOptIn.get(activeSession.sessionKey) ?? false
      : false,
  );
  const claudeTasks = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.backgroundTasks.get(activeSession.sessionKey) ?? EMPTY_CLAUDE_TASKS
      : EMPTY_CLAUDE_TASKS,
  );
  const openCodeHealth = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.runtimeHealth.get(activeSession.environmentId)
      : undefined,
  );
  /*
   * Todos and diffs belong to one session, but the environment-keyed snapshot
   * is written by whichever OpenCode tab reported last. `OpenCodeChatTab`
   * mirrors its own snapshot under the session key, so prefer that and fall
   * back to the environment entry only until the first session-scoped write.
   */
  const openCodeSessionHealth = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.runtimeHealth.get(activeSession.sessionKey)
      : undefined,
  );
  const openCodeAgent = useOpenCodeStore((state) =>
    activeSession?.provider === "opencode"
      ? state.selectedAgent.get(activeSession.sessionKey)
      : undefined,
  );

  const usage =
    activeSession?.provider === "claude"
      ? claudeUsage
      : activeSession?.provider === "opencode"
        ? openCodeUsage
        : activeSession?.provider === "codex"
          ? codexUsage
          : undefined;
  const modelId =
    activeSession?.provider === "claude"
      ? claudeModel
      : activeSession?.provider === "opencode"
        ? openCodeModel
        : activeSession?.provider === "codex"
          ? codexModel
          : undefined;

  const currentSessionId =
    activeSession?.provider === "claude"
      ? claudeSession?.sessionId
      : activeSession?.provider === "opencode"
        ? openCodeSession?.sessionId
        : activeSession?.provider === "codex"
          ? codexSession?.sessionId
          : undefined;
  const currentSessionLoading =
    activeSession?.provider === "claude"
      ? claudeSession?.isLoading ?? false
      : activeSession?.provider === "opencode"
        ? openCodeSession?.isLoading ?? false
        : activeSession?.provider === "codex"
          ? codexSession?.isLoading ?? false
          : false;
  /*
   * The tab key is not enough: resume replaces the provider session beneath
   * the same tab. Including the provider session id makes transient controls
   * change ownership immediately on both tab switches and same-tab resumes.
   */
  const sessionIdentity = activeSession
    ? `${activeSession.provider}:${activeSession.sessionKey}:${currentSessionId ?? "pending"}`
    : null;
  const currentSessionIdentityRef = useRef(sessionIdentity);
  currentSessionIdentityRef.current = sessionIdentity;
  const busyAction =
    busyState?.sessionIdentity === sessionIdentity ? busyState.name : null;
  const steerText =
    steerState.sessionIdentity === sessionIdentity ? steerState.value : "";
  const openCodeShared =
    shareState.sessionIdentity === sessionIdentity && shareState.value;

  useEffect(() => {
    if (
      !open
      || activeSession?.provider !== "codex"
      || !codexClient
      || !currentSessionId
    ) {
      setCodexHealth(null);
      return;
    }
    let cancelled = false;
    void getCodexRuntimeHealth(codexClient, currentSessionId)
      .then((health) => {
        if (cancelled) return;
        setCodexHealth(health);
        if (activeSession) {
          const limits = codexLimitsFromHealth(health);
          const store = useCodexStore.getState();
          const current = store.contextUsage.get(activeSession.sessionKey);
          if (current && (limits.rateLimits.length > 0 || limits.credits)) {
            store.setContextUsage(activeSession.sessionKey, {
              ...current,
              ...limits,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setCodexHealth({ error: "Runtime health unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.provider, codexClient, currentSessionId, open]);

  const openForkTab = (
    sessionId: string,
    title: string | undefined,
    closeCurrentPanel: boolean,
  ) => {
    if (!activeTab || !activeSession) return;
    const id = createUuid();
    /*
     * Built field by field, never by spreading the source tab. `TabInfo`
     * carries one-shot bootstrap fields (`initialPrompt`, `initialCommands`,
     * `initialAgentModel`, `initialReasoningEffort`) that are cleared only once
     * consumed; forking a tab whose initial prompt had not run yet produced a
     * fork that immediately auto-submitted it. The three in-tab fork handlers
     * construct their tabs the same way.
     */
    const tab: TabInfo = {
      id,
      type: activeTab.type,
      displayTitle: title ?? `${activeSession.providerLabel} fork`,
      ...(activeSession.provider === "claude"
        ? {
            claudeNativeData: {
              ...activeTab.claudeNativeData!,
              sessionId,
            },
          }
        : activeSession.provider === "opencode"
          ? {
              openCodeNativeData: {
                ...activeTab.openCodeNativeData!,
                sessionId,
              },
            }
          : {
              codexNativeData: {
                ...activeTab.codexNativeData!,
                sessionId,
              },
            }),
    };
    const panes = usePaneLayoutStore.getState();
    panes.addTab(
      panes.getActivePaneId(activeSession.environmentId),
      tab,
      activeSession.environmentId,
    );
    if (closeCurrentPanel) setOpen(false);
  };

  const openHandoffTab = (
    destination: AgentProvider,
    handoffId: string,
  ) => {
    if (!activeTab || !activeSession) return;
    const sourceData =
      activeTab.claudeNativeData
      ?? activeTab.openCodeNativeData
      ?? activeTab.codexNativeData;
    if (!sourceData) return;
    const nativeData = {
      containerId: sourceData.containerId,
      environmentId: activeSession.environmentId,
      isLocal: sourceData.isLocal,
    };
    const id = createUuid();
    const destinationLabel = AGENT_PROVIDER_LABELS[destination];
    const tab: TabInfo = {
      id,
      type: `${destination}-native` as TabInfo["type"],
      displayTitle: `${destinationLabel} · from ${AGENT_PROVIDER_LABELS[activeSession.provider]}`,
      agentHandoffId: handoffId,
      ...(destination === "claude"
        ? { claudeNativeData: nativeData }
        : destination === "opencode"
          ? { openCodeNativeData: nativeData }
          : { codexNativeData: nativeData }),
    };
    const panes = usePaneLayoutStore.getState();
    panes.addTab(
      panes.getActivePaneId(activeSession.environmentId),
      tab,
      activeSession.environmentId,
    );
    setOpen(false);
  };

  const readAuthoritativeHandoffMessages = async (): Promise<NativeMessage[]> => {
    if (!activeSession || !currentSessionId) {
      throw new Error("No active conversation is available");
    }
    if (activeSession.provider === "claude" && claudeClient) {
      const status = await getClaudeSession(claudeClient, currentSessionId);
      if (!status) throw new Error("Claude session is unavailable");
      if (status.status !== "idle") {
        throw new Error("Wait for Claude to finish before continuing in another agent");
      }
      const messages = normalizeClaudeMessagesForDisplay(
        await getClaudeSessionMessages(
          claudeClient,
          currentSessionId,
          { throwOnError: true },
        ),
      );
      const statusAfterRead = await getClaudeSession(claudeClient, currentSessionId);
      if (!statusAfterRead) throw new Error("Claude session is unavailable");
      if (statusAfterRead.status !== "idle") {
        throw new Error("Claude started working while its conversation was being transferred");
      }
      if (statusAfterRead.lastActivity !== status.lastActivity) {
        throw new Error("Claude conversation changed while it was being transferred");
      }
      return messages;
    }
    if (activeSession.provider === "opencode" && openCodeClient) {
      const status = await getOpenCodeSessionStatus(
        openCodeClient,
        currentSessionId,
        { throwOnError: true },
      );
      if (!status) throw new Error("OpenCode session is unavailable");
      if (status === "busy" || status === "retry") {
        throw new Error("Wait for OpenCode to finish before continuing in another agent");
      }
      const messages = (
        await getOpenCodeSessionMessages(
          openCodeClient,
          currentSessionId,
          { throwOnError: true },
        )
      ).map(normalizeOpenCodeNativeMessage);
      const statusAfterRead = await getOpenCodeSessionStatus(
        openCodeClient,
        currentSessionId,
        { throwOnError: true },
      );
      if (!statusAfterRead) throw new Error("OpenCode session is unavailable");
      if (statusAfterRead === "busy" || statusAfterRead === "retry") {
        throw new Error("OpenCode started working while its conversation was being transferred");
      }
      const messagesAfterRead = (
        await getOpenCodeSessionMessages(
          openCodeClient,
          currentSessionId,
          { throwOnError: true },
        )
      ).map(normalizeOpenCodeNativeMessage);
      const finalStatus = await getOpenCodeSessionStatus(
        openCodeClient,
        currentSessionId,
        { throwOnError: true },
      );
      if (!finalStatus) throw new Error("OpenCode session is unavailable");
      if (finalStatus === "busy" || finalStatus === "retry") {
        throw new Error("OpenCode started working while its conversation was being transferred");
      }
      // OpenCode exposes no revision counter, so a second read is the only way
      // to detect a turn that started and finished inside the read window.
      // Compare digests rather than serializing both transcripts twice: these
      // can be tens of megabytes and this runs on the main thread.
      if (
        agentHandoffTranscriptDigest(messagesAfterRead)
        !== agentHandoffTranscriptDigest(messages)
      ) {
        throw new Error("OpenCode conversation changed while it was being transferred");
      }
      return messagesAfterRead;
    }
    if (activeSession.provider === "codex" && codexClient) {
      const status = await getCodexSessionStatus(
        codexClient,
        currentSessionId,
        { throwOnError: true },
      );
      if (!status) throw new Error("Codex session is unavailable");
      if (status.status !== "idle") {
        throw new Error("Wait for Codex to finish before continuing in another agent");
      }
      const messages = (
        await getCodexSessionMessages(
          codexClient,
          currentSessionId,
          { throwOnError: true },
        )
      ).map(normalizeCodexNativeMessage);
      const statusAfterRead = await getCodexSessionStatus(
        codexClient,
        currentSessionId,
        { throwOnError: true },
      );
      if (!statusAfterRead) throw new Error("Codex session is unavailable");
      if (statusAfterRead.status !== "idle") {
        throw new Error("Codex started working while its conversation was being transferred");
      }
      if (
        status.messageRevision !== undefined
        && statusAfterRead.messageRevision !== undefined
      ) {
        if (statusAfterRead.messageRevision !== status.messageRevision) {
          throw new Error("Codex conversation changed while it was being transferred");
        }
        return messages;
      }
      /*
       * `messageRevision` is optional: an older bridge or a malformed status
       * payload drops it. Treating that as "unchanged" would fail open and
       * transfer a torn snapshot silently, so re-read and compare instead.
       */
      const messagesAfterRead = (
        await getCodexSessionMessages(
          codexClient,
          currentSessionId,
          { throwOnError: true },
        )
      ).map(normalizeCodexNativeMessage);
      if (
        agentHandoffTranscriptDigest(messagesAfterRead)
        !== agentHandoffTranscriptDigest(messages)
      ) {
        throw new Error("Codex conversation changed while it was being transferred");
      }
      return messagesAfterRead;
    }
    throw new Error(`${activeSession.providerLabel} is not connected`);
  };

  const runAction = async (
    name: string,
    action: (scope: { isCurrent: () => boolean; sessionIdentity: string }) => Promise<void>,
  ) => {
    if (!sessionIdentity) return;
    const actionId = ++actionIdRef.current;
    const actionState = { actionId, name, sessionIdentity };
    const isCurrent = () => currentSessionIdentityRef.current === sessionIdentity;
    setBusyState(actionState);
    try {
      await action({ isCurrent, sessionIdentity });
    } catch (error) {
      if (isCurrent()) {
        toast.error(error instanceof Error ? error.message : `${name} failed`);
      }
    } finally {
      setBusyState((current) =>
        current?.actionId === actionId
          && current.sessionIdentity === sessionIdentity
          ? null
          : current,
      );
    }
  };

  const forkCurrent = () => runAction("fork", async ({ isCurrent }) => {
    if (!activeSession || !currentSessionId) return;
    if (activeSession.provider === "claude" && claudeClient) {
      const fork = await forkClaudeSession(claudeClient, currentSessionId);
      openForkTab(fork.sessionId, fork.title, isCurrent());
    } else if (activeSession.provider === "opencode" && openCodeClient) {
      const fork = await forkOpenCodeSession(openCodeClient, currentSessionId);
      openForkTab(fork.id, fork.title, isCurrent());
    } else if (activeSession.provider === "codex" && codexClient) {
      /*
       * The bridge differentiates its refusals (404 missing, 409 running, 422
       * not a fork point, 503 unavailable) and `CodexForkError` carries that
       * body verbatim. The old single message blamed "an active or empty
       * session" for all four, including a bridge that was simply down.
       */
      let fork: Awaited<ReturnType<typeof forkCodexSession>>;
      try {
        fork = await forkCodexSession(codexClient, currentSessionId);
      } catch (error) {
        throw error instanceof CodexForkError
          ? error
          : new Error("Failed to fork Codex session");
      }
      openForkTab(fork.sessionId, fork.title, isCurrent());
    }
  });

  const continueIn = (destination: AgentProvider) =>
    runAction(`continue-${destination}`, async ({ isCurrent }) => {
      if (!activeSession || !currentSessionId) return;
      if (destination === activeSession.provider) return;
      if (currentSessionLoading) {
        throw new Error(
          `Wait for ${AGENT_PROVIDER_LABELS[activeSession.provider]} to finish before transferring`,
        );
      }
      const providerMessages = await readAuthoritativeHandoffMessages();
      if (!isCurrent()) return;
      const priorHandoff = activeTab?.agentHandoffId
        ? await loadAgentHandoff(activeTab.agentHandoffId)
        : null;
      if (activeTab?.agentHandoffId && !priorHandoff) {
        throw new Error("The previous conversation transfer could not be loaded");
      }
      if (
        priorHandoff
        && (
          priorHandoff.environmentId !== activeSession.environmentId
          || priorHandoff.destinationProvider !== activeSession.provider
        )
      ) {
        throw new Error("The previous conversation transfer does not belong to this session");
      }
      if (!isCurrent()) return;
      const messages = composeAgentHandoffTransferMessages(
        priorHandoff,
        providerMessages,
      );
      if (messages.length === 0) {
        throw new Error("This conversation has no history to transfer");
      }
      const handoff = createAgentHandoffSnapshot({
        id: createUuid(),
        environmentId: activeSession.environmentId,
        sourceProvider: activeSession.provider,
        destinationProvider: destination,
        sourceSessionId: currentSessionId,
        sourceTitle:
          activeSession.provider === "claude"
            ? claudeSession?.title
            : activeSession.provider === "opencode"
              ? openCodeSession?.title
              : codexSession?.title,
        sourceModel: modelId,
        sourceAgent:
          activeSession.provider === "claude"
            ? claudeAgent
            : activeSession.provider === "opencode"
              ? openCodeAgent
              : undefined,
        messages,
      });
      await persistAgentHandoff(handoff);
      if (!isCurrent()) {
        // The source tab changed while persistence was in flight, so no
        // destination tab will own this sensitive snapshot. Remove it instead
        // of leaving an unreachable handoff in durable storage.
        forgetAgentHandoff(handoff.id);
        await deleteAgentHandoff(handoff.id, handoff.environmentId);
        return;
      }
      openHandoffTab(destination, handoff.id);
      toast.success(
        `Continuing in ${AGENT_PROVIDER_LABELS[destination]} with `
        + `${formatCount(handoff.stats.messageCount, "message")} and `
        + formatCount(handoff.stats.toolCallCount, "tool call"),
      );
    });

  const compactCurrent = () => runAction("compact", async () => {
    if (!activeSession || !currentSessionId) return;
    const succeeded =
      activeSession.provider === "claude" && claudeClient
        ? await compactClaudeSession(claudeClient, currentSessionId)
        : activeSession.provider === "opencode" && openCodeClient
          ? (await compactOpenCodeSession(openCodeClient, currentSessionId, openCodeModel), true)
          : activeSession.provider === "codex" && codexClient
            ? await compactCodexSession(codexClient, currentSessionId)
            : false;
    if (!succeeded) throw new Error("The provider could not compact this session");
    toast.success("Context compaction started");
  });

  const close = () => {
    restoreFocusRef.current = true;
    setOpen(false);
  };

  /*
   * One component instance serves every tab, so everything typed or latched
   * for the previous session has to go when the active tab changes. `steerText`
   * in particular is posted to `currentSessionId`: text composed for session A
   * would otherwise be delivered to session B's active turn.
   */
  useEffect(() => {
    setOpen(false);
    setHandoffOpen(false);
    shareVersionRef.current += 1;
    setShareState({ sessionIdentity, value: false });
    setSteerState({ sessionIdentity, value: "" });
  }, [sessionIdentity]);

  /*
   * `openCodeShared` is an optimistic flag; the server's session record is the
   * truth. Re-reading it whenever the popover opens is what makes revocation
   * reachable after a tab switch or an app restart — component state alone
   * loses the fact that the conversation is published while the link stays
   * live.
   */
  useEffect(() => {
    if (
      !open
      || activeSession?.provider !== "opencode"
      || !openCodeClient
      || !currentSessionId
    ) {
      return;
    }
    let cancelled = false;
    const shareVersion = shareVersionRef.current;
    const requestedIdentity = sessionIdentity;
    void readOpenCodeShareUrl(openCodeClient, currentSessionId)
      .then((url) => {
        if (
          !cancelled
          && requestedIdentity !== null
          && currentSessionIdentityRef.current === requestedIdentity
          && shareVersionRef.current === shareVersion
        ) {
          // The provider snapshot is authoritative in both directions. A null
          // URL means a formerly shared session was revoked elsewhere.
          setShareState({ sessionIdentity: requestedIdentity, value: Boolean(url) });
        }
      })
      .catch((error: unknown) => {
        // A failed lookup must not clear the flag: that would hide "Stop
        // sharing" for a conversation that is still published.
        console.warn("[AgentInfoButton] Failed to read OpenCode share state:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSession?.provider,
    currentSessionId,
    open,
    openCodeClient,
    sessionIdentity,
  ]);

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  /*
   * Escape must be *claimed*, not merely observed. All three chat tabs bind a
   * window-level Escape handler that aborts the running turn, guarded only by
   * `event.defaultPrevented`; dismissing this popover mid-turn used to kill the
   * turn as well. Capture phase makes the outcome independent of mount order —
   * the tab's bubble-phase listener sees the key already consumed however the
   * two components happened to mount.
   */
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [open]);

  return (
    <div
      className={cn("relative", mobile ? "h-9 w-9" : "h-8 w-8")}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Button
        ref={triggerRef}
        variant={open ? "secondary" : "ghost"}
        size="icon"
        className={mobile ? "h-9 w-9" : "h-8 w-8 text-muted-foreground hover:text-foreground"}
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close agent information" : "Open agent information"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="agent-information-popover"
      >
        <Info className={mobile ? "h-4.5 w-4.5" : "h-4 w-4"} />
      </Button>

      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={close}
          aria-label="Close agent information"
        />
      ) : null}

      <section
        id="agent-information-popover"
        role="dialog"
        aria-label="Agent information"
        aria-hidden={!open}
        className={cn(
          "absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(calc(100vw-1rem),23rem)] origin-top-right overflow-hidden rounded-xl border border-border/80 bg-popover/98 shadow-[0_22px_70px_rgba(0,0,0,0.52)] backdrop-blur-xl transition duration-150",
          open
            ? "visible scale-100 opacity-100"
            : "pointer-events-none invisible scale-95 opacity-0",
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
              Active session
            </div>
            <h2 className="mt-1 truncate text-sm font-semibold text-foreground">
              {activeSession?.providerLabel ?? "No native agent"}
            </h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-1 -mt-1 h-7 w-7 text-muted-foreground"
            onClick={close}
            aria-label="Close agent information"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>

        <div className="max-h-[min(76vh,42rem)] overflow-y-auto p-4">
          {activeSession ? (
            <div className="space-y-5">
              <UsagePanel
                usage={usage}
                modelId={modelId}
                rateLimits={
                  activeSession.provider === "claude"
                    ? claudeRateLimits
                    : undefined
                }
              />

              {(activeSession.provider === "claude" && (claudeInit?.agents?.length ?? 0) > 0)
              || (activeSession.provider === "opencode" && (openCodeHealth?.agents.length ?? 0) > 0)
                ? (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      Execution profile
                    </div>
                    <select
                      value={activeSession.provider === "claude"
                        ? claudeAgent ?? ""
                        : openCodeAgent ?? ""}
                      onChange={(event) => {
                        const value = event.target.value || undefined;
                        if (activeSession.provider === "claude") {
                          useClaudeStore.getState().setSelectedAgent(
                            activeSession.sessionKey,
                            value,
                          );
                        } else {
                          useOpenCodeStore.getState().setSelectedAgent(
                            activeSession.sessionKey,
                            value,
                          );
                        }
                      }}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      aria-label="Execution profile"
                    >
                      <option value="">Provider default</option>
                      {(activeSession.provider === "claude"
                        ? claudeInit?.agents ?? []
                        : openCodeHealth?.agents.filter(
                            (agent) => agent.mode === "primary" || agent.mode === "all",
                          ) ?? []
                      ).map((agent) => (
                        <option key={agent.name} value={agent.name}>
                          {agent.name}{
                            ("mode" in agent ? agent.modelId : agent.model)
                              ? ` · ${"mode" in agent ? agent.modelId : agent.model}`
                              : ""
                          }
                        </option>
                      ))}
                    </select>
                  </div>
                )
                : null}

              {/*
                Deliberately outside the execution-profile block. These are
                session options, not agent options: `sessionInitData.agents`
                defaults to `[]`, so nesting them under a non-empty agent list
                hid both toggles — including the prompt-suggestion opt-in that
                gates the feature — for any Claude session whose init payload
                omitted agents.
              */}
              {activeSession.provider === "claude" ? (
                <div className="space-y-1.5 border-t border-border/60 pt-4">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                    Session options
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={includeLocalSettings}
                      onChange={(event) =>
                        useClaudeStore.getState().setIncludeLocalSettings(
                          activeSession.sessionKey,
                          event.target.checked,
                        )}
                    />
                    Include .claude/settings.local.json
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={promptSuggestionOptIn}
                      onChange={(event) =>
                        useClaudeStore.getState().setPromptSuggestionOptIn(
                          activeSession.sessionKey,
                          event.target.checked,
                        )}
                    />
                    Suggest a follow-up after each turn
                  </label>
                </div>
              ) : null}

              <div className="space-y-2 border-t border-border/60 pt-4">
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                  Session actions
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!currentSessionId || busyAction !== null}
                    onClick={() => void forkCurrent()}
                    className="justify-start gap-2"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Fork session
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!currentSessionId || busyAction !== null}
                    onClick={() => void compactCurrent()}
                    className="justify-start gap-2"
                  >
                    <Scissors className="h-3.5 w-3.5" />
                    Compact
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !currentSessionId
                      || currentSessionLoading
                      || busyAction !== null
                    }
                    aria-expanded={handoffOpen}
                    onClick={() => setHandoffOpen((value) => !value)}
                    className={cn(
                      "col-span-2 justify-start gap-2",
                      handoffOpen && "border-primary/40 bg-primary/5",
                    )}
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                    Continue in…
                  </Button>

                  {handoffOpen ? (
                    <div className="col-span-2 rounded-lg border border-border/70 bg-muted/20 p-2.5">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium">
                          {AGENT_PROVIDER_LABELS[activeSession.provider]}
                        </span>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
                          {(Object.keys(AGENT_PROVIDER_LABELS) as AgentProvider[])
                            .filter((provider) => provider !== activeSession.provider)
                            .map((provider) => (
                              <Button
                                key={provider}
                                variant="secondary"
                                size="sm"
                                className="h-8 min-w-0 px-2 text-xs"
                                disabled={busyAction !== null || currentSessionLoading}
                                onClick={() => void continueIn(provider)}
                              >
                                {busyAction === `continue-${provider}`
                                  ? "Preparing…"
                                  : AGENT_PROVIDER_LABELS[provider]}
                              </Button>
                            ))}
                        </div>
                      </div>
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        Copies the completed transcript and tool history into a new
                        agent. This source session stays intact; live tasks and
                        approvals do not transfer.
                      </p>
                    </div>
                  ) : null}

                  {activeSession.provider === "claude" && claudeClient && currentSessionId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAction !== null}
                      className="justify-start gap-2"
                      onClick={() => void runAction("rewind", async () => {
                        const target = claudeSession?.messages
                          .filter((message) => message.role === "user")
                          .at(-1);
                        if (!target?.id) throw new Error("No file checkpoint is available");
                        const preview = await rewindClaudeFiles(
                          claudeClient,
                          currentSessionId,
                          target.id,
                          true,
                        );
                        /*
                         * This mutates the worktree, so the confirmation names
                         * the message it is anchored to and lists the files it
                         * will touch. It used to paste a truncated
                         * `JSON.stringify` of the dry run into the dialog.
                         */
                        const { files, fileCount } = summarizeRewindPreview(preview);
                        const shown = files.slice(0, 10);
                        const body = fileCount === 0
                          ? "Claude reported no file changes for this checkpoint."
                          : [
                              `${fileCount} ${fileCount === 1 ? "file" : "files"} will be restored:`,
                              ...shown.map((file) => `  • ${file}`),
                              ...(files.length > shown.length
                                ? [`  • …and ${files.length - shown.length} more`]
                                : []),
                            ].join("\n");
                        if (!window.confirm(
                          [
                            `Rewind your files to the state before ${describeRewindTarget(target.content)}?`,
                            body,
                            "This overwrites the working tree and cannot be undone.",
                          ].join("\n\n"),
                        )) return;
                        await rewindClaudeFiles(
                          claudeClient,
                          currentSessionId,
                          target.id,
                        );
                        toast.success(
                          fileCount === 0
                            ? "Claude files rewound"
                            : `Claude restored ${fileCount} ${fileCount === 1 ? "file" : "files"}`,
                        );
                      })}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Rewind files
                    </Button>
                  ) : null}

                  {activeSession.provider === "opencode" && openCodeClient && currentSessionId ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() => void runAction("undo", async () => {
                          const messageId = openCodeSession?.messages
                            .filter((message) => message.role === "user")
                            .at(-1)?.id;
                          await revertOpenCodeSession(
                            openCodeClient,
                            currentSessionId,
                            messageId,
                          );
                          toast.success("OpenCode session reverted");
                        })}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Undo turn
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() => void runAction(
                          "share",
                          async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                            if (!window.confirm(
                              "Create an OpenCode share link? The conversation will leave this machine and be accessible to anyone with the link.",
                            )) return;
                            shareVersionRef.current += 1;
                            const url = await shareOpenCodeSession(
                              openCodeClient,
                              currentSessionId,
                            );
                            /*
                             * The conversation is published the moment `share()`
                             * resolves. Latch that first: every failure after this
                             * point (a missing URL, a clipboard rejection on focus
                             * or permission grounds) used to skip the flag, so the
                             * user saw an error while the link was live and
                             * "Stop sharing" never rendered.
                             */
                            if (isCurrent()) {
                              setShareState({
                                sessionIdentity: actionIdentity,
                                value: true,
                              });
                            }
                            // The originating session is now shared, but a
                            // different active session must not receive its URL,
                            // clipboard side effect, or notification.
                            if (!isCurrent()) return;
                            if (!url) {
                              toast.warning(
                                "Session shared, but OpenCode did not return the link. Use Stop sharing to revoke it.",
                              );
                              return;
                            }
                            try {
                              await navigator.clipboard.writeText(url);
                              if (isCurrent()) toast.success("Share link copied");
                            } catch {
                              if (isCurrent()) toast.warning(
                                `Session shared, but the link could not be copied: ${url}`,
                              );
                            }
                          },
                        )}
                      >
                        <Share2 className="h-3.5 w-3.5" />
                        Share…
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        className="justify-start gap-2"
                        onClick={() => void runAction("redo", async () => {
                          await unrevertOpenCodeSession(
                            openCodeClient,
                            currentSessionId,
                          );
                          toast.success("OpenCode revert undone");
                        })}
                      >
                        <RotateCcw className="h-3.5 w-3.5 scale-x-[-1]" />
                        Redo turn
                      </Button>
                      {openCodeShared ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyAction !== null}
                          className="justify-start gap-2"
                          onClick={() => void runAction(
                            "unshare",
                            async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                              shareVersionRef.current += 1;
                              await unshareOpenCodeSession(
                                openCodeClient,
                                currentSessionId,
                              );
                              if (isCurrent()) {
                                setShareState({
                                  sessionIdentity: actionIdentity,
                                  value: false,
                                });
                                toast.success("OpenCode share link disabled");
                              }
                            },
                          )}
                        >
                          <X className="h-3.5 w-3.5" />
                          Stop sharing
                        </Button>
                      ) : null}
                    </>
                  ) : null}

                  {activeSession.provider === "codex" && codexClient && currentSessionId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAction !== null || codexSession?.isLoading}
                      className="justify-start gap-2"
                      onClick={() => void runAction("review", async () => {
                        const started = await startCodexNativeReview(
                          codexClient,
                          currentSessionId,
                        );
                        if (!started) throw new Error("Codex native review could not start");
                        toast.success("Reviewing uncommitted changes");
                      })}
                    >
                      <Info className="h-3.5 w-3.5" />
                      Review changes
                    </Button>
                  ) : null}
                </div>
              </div>

              {activeSession.provider === "codex"
                && codexClient
                && currentSessionId
                && codexSession?.isLoading
                ? (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      Active turn
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={steerText}
                        onChange={(event) => setSteerState({
                          sessionIdentity,
                          value: event.target.value,
                        })}
                        placeholder="Correct or redirect Codex"
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={!steerText.trim() || busyAction !== null}
                        onClick={() => void runAction(
                          "steer",
                          async ({ isCurrent, sessionIdentity: actionIdentity }) => {
                            const text = steerText.trim();
                            const sent = await steerCodexSession(
                              codexClient,
                              currentSessionId,
                              text,
                              createUuid(),
                            );
                            if (!sent) {
                              throw new Error("The active turn changed; your text was not sent");
                            }
                            if (isCurrent()) {
                              setSteerState({
                                sessionIdentity: actionIdentity,
                                value: "",
                              });
                              toast.success("Sent to the active turn");
                            }
                          },
                        )}
                      >
                        Send now
                      </Button>
                    </div>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      Sends directly to the current Codex turn. Regular compose messages still queue.
                    </p>
                  </div>
                )
                : null}

              {activeSession.provider === "claude"
                && claudeClient
                && currentSessionId
                && Object.values(claudeTasks).some(
                  (task) =>
                    task.status === "running"
                    || task.status === "pending"
                    || task.status === "paused",
                )
                ? (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      Background tasks
                    </div>
                    {Object.values(claudeTasks)
                      .filter(
                        (task) =>
                          task.status === "running"
                          || task.status === "pending"
                          || task.status === "paused",
                      )
                      .map((task) => (
                        <div key={task.id} className="flex items-center justify-between gap-3 text-xs">
                          <span className="min-w-0 truncate">
                            {task.description ?? task.id}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 shrink-0 gap-1.5"
                            onClick={() => void runAction(`stop-${task.id}`, async () => {
                              const stopped = await stopClaudeBackgroundTask(
                                claudeClient,
                                currentSessionId,
                                task.id,
                              );
                              if (!stopped) throw new Error("Claude could not stop this task");
                            })}
                          >
                            <Square className="h-3 w-3" />
                            Stop
                          </Button>
                        </div>
                      ))}
                  </div>
                )
                : null}

              <div className="space-y-2 border-t border-border/60 pt-4">
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                  Runtime
                </div>
                {activeSession.provider === "claude" ? (
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <Metric label="MCP" value={String(claudeInit?.mcpServers.length ?? 0)} />
                    <Metric label="Plugins" value={String(claudeInit?.plugins.length ?? 0)} />
                    <Metric label="Commands" value={String(claudeInit?.slashCommands?.length ?? 0)} />
                  </div>
                ) : activeSession.provider === "opencode" ? (
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <Metric label="MCP" value={String(openCodeHealth?.mcpServers.length ?? 0)} />
                    <Metric label="Skills" value={String(openCodeHealth?.skills.length ?? 0)} />
                    <Metric label="LSP" value={String(openCodeHealth?.lspServers.length ?? 0)} />
                    <Metric
                      label="Todos"
                      value={String(
                        (openCodeSessionHealth ?? openCodeHealth)?.todos?.length ?? 0,
                      )}
                    />
                    <Metric
                      label="Files"
                      value={String(
                        (openCodeSessionHealth ?? openCodeHealth)?.diffs?.length ?? 0,
                      )}
                    />
                  </div>
                ) : (
                  <CodexRuntimePanel health={codexHealth} />
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/70 px-4 py-5">
              <p className="text-sm text-foreground">Select a native agent tab.</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Context, tokens, cost, limits, and runtime details are scoped to the active Claude, OpenCode, or Codex session.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
