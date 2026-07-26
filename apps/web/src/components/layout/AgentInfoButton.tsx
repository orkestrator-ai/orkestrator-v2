import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
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
import { cn } from "@/lib/utils";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { formatTokenCount } from "@/lib/context-usage";
import type { TabInfo } from "@/types/paneLayout";
import {
  createClaudeSessionKey,
  useClaudeStore,
} from "@/stores/claudeStore";
import {
  createCodexSessionKey,
  useCodexStore,
} from "@/stores/codexStore";
import {
  createOpenCodeSessionKey,
  useOpenCodeStore,
} from "@/stores/openCodeStore";
import {
  compactClaudeSession,
  forkClaudeSession,
  rewindClaudeFiles,
  stopClaudeBackgroundTask,
} from "@/lib/claude-client";
import {
  compactOpenCodeSession,
  forkOpenCodeSession,
  revertOpenCodeSession,
  shareOpenCodeSession,
  unrevertOpenCodeSession,
  unshareOpenCodeSession,
} from "@/lib/opencode-client";
import {
  compactCodexSession,
  forkCodexSession,
  getCodexRuntimeHealth,
  startCodexNativeReview,
  steerCodexSession,
} from "@/lib/codex-client";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { createUuid } from "@/lib/uuid";

interface AgentInfoButtonProps {
  activeTab: TabInfo | null;
  mobile?: boolean;
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
      sessionKey: createClaudeSessionKey(environmentId, tab.id),
    };
  }
  if (tab?.type === "opencode-native" && tab.openCodeNativeData) {
    const environmentId = tab.openCodeNativeData.environmentId;
    return {
      provider: "opencode",
      providerLabel: "OpenCode",
      environmentId,
      sessionKey: createOpenCodeSessionKey(environmentId, tab.id),
    };
  }
  if (tab?.type === "codex-native" && tab.codexNativeData) {
    const environmentId = tab.codexNativeData.environmentId;
    return {
      provider: "codex",
      providerLabel: "Codex Native",
      environmentId,
      sessionKey: createCodexSessionKey(environmentId, tab.id),
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
}: {
  usage: ContextUsageSnapshot | undefined;
  modelId: string | undefined;
}) {
  if (!usage) {
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

      {usage.rateLimits && usage.rateLimits.length > 0 ? (
        <div className="space-y-3 border-t border-border/60 pt-4">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            Limits
          </div>
          {usage.rateLimits.map((limit) => (
            <div key={`${limit.label}:${limit.resetsAt ?? ""}`}>
              <div className="mb-1.5 flex justify-between gap-3 text-xs">
                <span className="text-foreground">{limit.label}</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {limit.usedPercent === undefined ? "Available" : `${limit.usedPercent.toFixed(0)}% used`}
                </span>
              </div>
              {limit.usedPercent !== undefined ? (
                <Progress value={limit.usedPercent} className="h-1" />
              ) : null}
              {limit.resetsAt ? (
                <div className="mt-1 text-right text-[10px] text-muted-foreground">
                  Resets {new Date(limit.resetsAt).toLocaleString()}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
        <span className="truncate">{usage.modelId ?? modelId ?? "Model unavailable"}</span>
        <span className="shrink-0">
          {usage.estimated ? "Estimated" : "Provider reported"}
        </span>
      </div>
    </div>
  );
}

export function AgentInfoButton({
  activeTab,
  mobile = false,
}: AgentInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [codexHealth, setCodexHealth] = useState<unknown>(null);
  const [steerText, setSteerText] = useState("");
  const [openCodeShared, setOpenCodeShared] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const activeSession = useMemo(
    () => resolveActiveNativeSession(activeTab),
    [activeTab],
  );

  const claudeUsage = useClaudeStore((state) =>
    activeSession?.provider === "claude"
      ? state.contextUsage.get(activeSession.sessionKey)
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

  const openForkTab = (sessionId: string, title?: string) => {
    if (!activeTab || !activeSession) return;
    const id = createUuid();
    const tab: TabInfo = {
      ...activeTab,
      id,
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
    setOpen(false);
  };

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${name} failed`);
    } finally {
      setBusyAction(null);
    }
  };

  const forkCurrent = () => runAction("fork", async () => {
    if (!activeSession || !currentSessionId) return;
    if (activeSession.provider === "claude" && claudeClient) {
      const fork = await forkClaudeSession(claudeClient, currentSessionId);
      openForkTab(fork.sessionId, fork.title);
    } else if (activeSession.provider === "opencode" && openCodeClient) {
      const fork = await forkOpenCodeSession(openCodeClient, currentSessionId);
      openForkTab(fork.id, fork.title);
    } else if (activeSession.provider === "codex" && codexClient) {
      const fork = await forkCodexSession(codexClient, currentSessionId);
      if (!fork) throw new Error("Codex cannot fork an active or empty session");
      openForkTab(fork.sessionId, fork.title);
    }
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

  useEffect(() => {
    setOpen(false);
    setOpenCodeShared(false);
  }, [activeTab?.id, activeSession?.environmentId]);

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
              <UsagePanel usage={usage} modelId={modelId} />

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
                    {activeSession.provider === "claude" ? (
                      <div className="space-y-1.5">
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
                  </div>
                )
                : null}

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

                  {activeSession.provider === "claude" && claudeClient && currentSessionId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAction !== null}
                      className="justify-start gap-2"
                      onClick={() => void runAction("rewind", async () => {
                        const messageId = claudeSession?.messages
                          .filter((message) => message.role === "user")
                          .at(-1)?.id;
                        if (!messageId) throw new Error("No file checkpoint is available");
                        const preview = await rewindClaudeFiles(
                          claudeClient,
                          currentSessionId,
                          messageId,
                          true,
                        );
                        if (!window.confirm(
                          `Rewind files through the latest user message?\n\n${JSON.stringify(preview, null, 2).slice(0, 800)}`,
                        )) return;
                        await rewindClaudeFiles(
                          claudeClient,
                          currentSessionId,
                          messageId,
                        );
                        toast.success("Claude files rewound");
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
                        onClick={() => void runAction("share", async () => {
                          if (!window.confirm(
                            "Create an OpenCode share link? The conversation will leave this machine and be accessible to anyone with the link.",
                          )) return;
                          const url = await shareOpenCodeSession(
                            openCodeClient,
                            currentSessionId,
                          );
                          if (!url) throw new Error("OpenCode did not return a share URL");
                          await navigator.clipboard.writeText(url);
                          setOpenCodeShared(true);
                          toast.success("Share link copied");
                        })}
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
                          onClick={() => void runAction("unshare", async () => {
                            await unshareOpenCodeSession(
                              openCodeClient,
                              currentSessionId,
                            );
                            setOpenCodeShared(false);
                            toast.success("OpenCode share link disabled");
                          })}
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
                        onChange={(event) => setSteerText(event.target.value)}
                        placeholder="Correct or redirect Codex"
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={!steerText.trim() || busyAction !== null}
                        onClick={() => void runAction("steer", async () => {
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
                          setSteerText("");
                          toast.success("Sent to the active turn");
                        })}
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
                  (task) => task.status === "running" || task.status === "pending",
                )
                ? (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      Background tasks
                    </div>
                    {Object.values(claudeTasks)
                      .filter((task) => task.status === "running" || task.status === "pending")
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
                    <Metric label="Todos" value={String(openCodeHealth?.todos?.length ?? 0)} />
                    <Metric label="Files" value={String(openCodeHealth?.diffs?.length ?? 0)} />
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
