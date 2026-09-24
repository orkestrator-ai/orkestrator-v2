import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";

import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  consumeMcpSettingsIntent,
  onMcpSettingsIntent,
  type McpSettingsIntent,
} from "@/lib/mcp-settings-navigation";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useEnvironmentStore } from "@/stores/environmentStore";

import { McpApplyStatus } from "./McpApplyStatus";
import { McpDiscardDialog } from "./McpDiscardDialog";
import { McpEntryDialog, type McpEntryAction } from "./McpEntryDialogs";
import { McpErrorNotice } from "./McpErrorNotice";
import { applyBlockedReason, writeBlockedReason } from "./mcp-rollout";
import { McpServerEditor, type McpEditorMode } from "./McpServerEditor";
import { McpSourceList } from "./McpSourceList";
import { useMcpSnapshot, useMcpTargets } from "./useMcpManagement";

const BACKEND_CONTEXT = "backend";

/**
 * Servers the coding agents connect to, per provider. Deliberately separate
 * from Control MCP (inbound access to Orkestrator itself).
 */
export function ProviderMcpSettings() {
  const initialIntent = useMemo<McpSettingsIntent>(() => consumeMcpSettingsIntent() ?? {}, []);
  const [provider, setProvider] = useState<AgentPlatform>(initialIntent.provider ?? "claude");
  const [contextId, setContextId] = useState<string>(
    initialIntent.environmentId ?? BACKEND_CONTEXT,
  );
  const [highlight, setHighlight] = useState<string | undefined>(initialIntent.serverName);
  const [editor, setEditor] = useState<McpEditorMode | null>(null);
  const [entryAction, setEntryAction] = useState<McpEntryAction | null>(null);
  const environments = useEnvironmentStore((state) => state.environments);
  // Whether the open editor/dialog holds unsaved input. A draft belongs to
  // one exact target, so switching target must discard it — explicitly.
  const dirtyRef = useRef(false);
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  // Dialogs have no DialogTrigger, so Radix cannot restore focus on its own.
  // The row action (or Add button) that opened one is remembered here.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const closeDialogs = () => {
    dirtyRef.current = false;
    setEditor(null);
    setEntryAction(null);
  };
  /** Run a target switch, confirming first when it would discard a draft. */
  const guardSwitch = (apply: () => void) => {
    const run = () => {
      closeDialogs();
      apply();
    };
    if (dirtyRef.current) setPendingSwitch(() => run);
    else run();
  };
  const guardSwitchRef = useRef(guardSwitch);
  guardSwitchRef.current = guardSwitch;
  const restoreFocus = () => {
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    const fallback = headingRef.current;
    if (element?.isConnected && !(element as HTMLButtonElement).disabled) element.focus();
    else fallback?.focus();
  };
  const openDialog = (trigger: HTMLElement, open: () => void) => {
    returnFocusRef.current = trigger;
    dirtyRef.current = false;
    open();
  };
  const setDirty = (dirty: boolean) => {
    dirtyRef.current = dirty;
  };

  useEffect(
    () =>
      onMcpSettingsIntent((intent) =>
        guardSwitchRef.current(() => {
          if (intent.provider) setProvider(intent.provider);
          setContextId(intent.environmentId ?? BACKEND_CONTEXT);
          setHighlight(intent.serverName);
        }),
      ),
    [],
  );

  const environmentId = contextId === BACKEND_CONTEXT ? null : contextId;
  const { state: targetsState } = useMcpTargets(environmentId);
  const targets =
    targetsState.status === "ready" ||
    targetsState.status === "loading" ||
    targetsState.status === "error"
      ? (targetsState.data ?? [])
      : [];
  // Match the exact context, not just its kind: a list still loading for a
  // previous environment must never supply that environment's target here.
  const target = targets.find(
    (candidate) =>
      candidate.provider === provider &&
      candidate.context.kind === (environmentId ? "environment" : "backend") &&
      (candidate.context.environmentId ?? null) === environmentId,
  );
  const { state: snapshotState, reload } = useMcpSnapshot(target?.targetId ?? null);
  const snapshot = "data" in snapshotState ? snapshotState.data : null;
  const current = snapshot && snapshot.target.targetId === target?.targetId ? snapshot : null;

  const selectContext = (next: string) => guardSwitch(() => setContextId(next));

  if (targetsState.status === "unsupported" || snapshotState.status === "unsupported") {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-white/10 p-5 text-sm text-muted-foreground">
        This backend does not support managing MCP servers yet. Update the backend to edit provider
        servers from here.
      </div>
    );
  }

  const writeBlocked = current ? writeBlockedReason(current.target.capabilities) : null;
  const applyBlocked = current ? applyBlockedReason(current.target.capabilities) : null;
  const canAdd =
    !!current &&
    !writeBlocked &&
    current.target.capabilities.operations.add.supported &&
    current.sources.some((source) => source.writable && source.format !== "runtime");

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-8">
      <div className="border-b border-white/10 pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          MCP servers for your agents
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Add, edit and remove the MCP servers each agent platform connects to. Changes are written
          to the provider's own configuration files. To let another agent control Orkestrator, use{" "}
          <button
            type="button"
            className="text-blue-300 underline-offset-2 hover:underline"
            onClick={() => requestGlobalSettings("mcp")}
          >
            Control MCP
          </button>
          .
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-provider">Agent platform</Label>
          <Select
            value={provider}
            onValueChange={(value) => guardSwitch(() => setProvider(value as AgentPlatform))}
          >
            <SelectTrigger id="mcp-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_PLATFORMS.map((platform) => (
                <SelectItem key={platform} value={platform}>
                  {AGENT_PLATFORM_LABELS[platform]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mcp-context">Configuration for</Label>
          <Select value={contextId} onValueChange={selectContext}>
            <SelectTrigger id="mcp-context">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BACKEND_CONTEXT}>
                Backend user (shared by every environment)
              </SelectItem>
              {environments
                .filter((environment) => !environment.deletionRequestedAt)
                .map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}{" "}
                    {environment.environmentType === "local" ? "(worktree)" : "(container)"}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          onClick={reload}
          disabled={!target}
        >
          <RefreshCw
            className={snapshotState.status === "loading" ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
        </Button>
      </div>

      {targetsState.status === "error" ? (
        <McpErrorNotice
          className="rounded-lg px-4 py-3"
          problem={{ message: targetsState.message, reference: targetsState.reference }}
        />
      ) : null}
      {snapshotState.status === "error" ? (
        <McpErrorNotice
          className="rounded-lg px-4 py-3"
          problem={{ message: snapshotState.message, reference: snapshotState.reference }}
        >
          <Button size="sm" variant="outline" onClick={reload}>
            Try again
          </Button>
        </McpErrorNotice>
      ) : null}

      {!current ? (
        snapshotState.status !== "error" && targetsState.status !== "error" ? (
          <div className="flex justify-center py-12" role="status" aria-label="Loading MCP servers">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        ) : null
      ) : (
        <>
          <div className="space-y-2 rounded-lg border border-white/10 bg-zinc-900/30 px-4 py-3 text-sm">
            <p className="text-foreground">
              {current.target.providerLabel} · {current.target.context.locationLabel}
            </p>
            <p className="text-xs text-muted-foreground">
              {current.target.capabilities.apply.description}
            </p>
            <p className="text-xs text-muted-foreground">
              {current.target.capabilities.terminal.guidance}
            </p>
            {current.target.readOnlyReason ? (
              <p className="text-xs text-amber-300" role="note">
                {current.target.readOnlyReason}
              </p>
            ) : null}
            {writeBlocked ? (
              <p className="text-xs text-amber-300" role="note">
                {writeBlocked}
              </p>
            ) : null}
            {applyBlocked && applyBlocked !== writeBlocked ? (
              <p className="text-xs text-amber-300" role="note">
                {applyBlocked}
              </p>
            ) : null}
            {current.freshness === "incomplete" ? (
              <p className="text-xs text-amber-300">
                Some configuration could not be read
                {current.truncated ? ` and ${current.truncated} rows are not shown` : ""}. Nothing
                is overwritten because of it.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3">
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Configured servers
            </h2>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!canAdd}
              title={
                canAdd
                  ? undefined
                  : (writeBlocked ??
                    current.target.readOnlyReason ??
                    (current.target.capabilities.operations.add.supported
                      ? "No writable configuration file is available."
                      : current.target.capabilities.operations.add.reason) ??
                    "Adding servers is not supported here.")
              }
              onClick={(event) => openDialog(event.currentTarget, () => setEditor({ kind: "add" }))}
            >
              <Plus className="h-4 w-4" /> Add server
            </Button>
          </div>

          <McpSourceList
            snapshot={current}
            highlightName={highlight}
            onEdit={(definition, trigger) =>
              openDialog(trigger, () => setEditor({ kind: "edit", entryId: definition.entryId }))
            }
            onRename={(definition, trigger) =>
              openDialog(trigger, () => setEntryAction({ kind: "rename", entry: definition }))
            }
            onRemove={(definition, trigger) =>
              openDialog(trigger, () => setEntryAction({ kind: "remove", entry: definition }))
            }
            onSetEnabled={(definition, trigger) =>
              openDialog(trigger, () => setEntryAction({ kind: "set-enabled", entry: definition }))
            }
          />

          <McpApplyStatus
            operations={current.operations}
            applyBlockedReason={applyBlocked ?? undefined}
          />

          {editor ? (
            <McpServerEditor
              key={`${current.target.targetId}:${editor.kind === "edit" ? editor.entryId : "add"}`}
              mode={editor}
              snapshot={current}
              onReload={reload}
              onDirtyChange={setDirty}
              onRestoreFocus={restoreFocus}
              onClose={() => {
                dirtyRef.current = false;
                setEditor(null);
                reload();
              }}
            />
          ) : null}
          {entryAction ? (
            <McpEntryDialog
              key={`${current.target.targetId}:${entryAction.kind}:${entryAction.entry.entryId}`}
              action={entryAction}
              snapshot={current}
              onReload={reload}
              onDirtyChange={setDirty}
              onRestoreFocus={restoreFocus}
              onClose={(done) => {
                // A removed or renamed row is about to disappear from the
                // list; focus the list heading rather than a vanishing button.
                if (done && entryAction.kind !== "set-enabled") returnFocusRef.current = null;
                dirtyRef.current = false;
                setEntryAction(null);
                reload();
              }}
            />
          ) : null}
        </>
      )}
      <McpDiscardDialog
        open={pendingSwitch !== null}
        onKeep={() => setPendingSwitch(null)}
        onDiscard={() => {
          const run = pendingSwitch;
          setPendingSwitch(null);
          run?.();
        }}
      />
    </div>
  );
}
