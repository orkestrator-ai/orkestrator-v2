import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCw } from "lucide-react";

import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { McpDefinitionSummary } from "@orkestrator/protocol/mcp-management";

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
import { McpEntryDialog, type McpEntryAction } from "./McpEntryDialogs";
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

  useEffect(
    () =>
      onMcpSettingsIntent((intent) => {
        if (intent.provider) setProvider(intent.provider);
        setContextId(intent.environmentId ?? BACKEND_CONTEXT);
        setHighlight(intent.serverName);
        setEditor(null);
        setEntryAction(null);
      }),
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
  const target = targets.find(
    (candidate) =>
      candidate.provider === provider &&
      candidate.context.kind === (environmentId ? "environment" : "backend"),
  );
  const { state: snapshotState, reload } = useMcpSnapshot(target?.targetId ?? null);
  const snapshot = "data" in snapshotState ? snapshotState.data : null;
  const current = snapshot && snapshot.target.targetId === target?.targetId ? snapshot : null;

  const selectContext = (next: string) => {
    // Drafts belong to one exact target; switching discards open editors.
    setEditor(null);
    setEntryAction(null);
    setContextId(next);
  };

  if (targetsState.status === "unsupported" || snapshotState.status === "unsupported") {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-white/10 p-5 text-sm text-muted-foreground">
        This backend does not support managing MCP servers yet. Update the backend to edit provider
        servers from here.
      </div>
    );
  }

  const canAdd =
    !!current &&
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
            onValueChange={(value) => {
              setEditor(null);
              setEntryAction(null);
              setProvider(value as AgentPlatform);
            }}
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

      {targetsState.status === "error" ? <ErrorNotice message={targetsState.message} /> : null}
      {snapshotState.status === "error" ? (
        <ErrorNotice message={snapshotState.message} onRetry={reload} />
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
            {current.freshness === "incomplete" ? (
              <p className="text-xs text-amber-300">
                Some configuration could not be read
                {current.truncated ? ` and ${current.truncated} rows are not shown` : ""}. Nothing
                is overwritten because of it.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-foreground">Configured servers</h2>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!canAdd}
              title={
                canAdd
                  ? undefined
                  : (current.target.readOnlyReason ??
                    "No writable configuration file is available.")
              }
              onClick={() => setEditor({ kind: "add" })}
            >
              <Plus className="h-4 w-4" /> Add server
            </Button>
          </div>

          <McpSourceList
            snapshot={current}
            highlightName={highlight}
            onEdit={(definition: McpDefinitionSummary) =>
              setEditor({ kind: "edit", entryId: definition.entryId })
            }
            onRename={(definition) => setEntryAction({ kind: "rename", entry: definition })}
            onRemove={(definition) => setEntryAction({ kind: "remove", entry: definition })}
          />

          <McpApplyStatus operations={current.operations} />

          {editor ? (
            <McpServerEditor
              key={`${current.target.targetId}:${editor.kind === "edit" ? editor.entryId : "add"}`}
              mode={editor}
              snapshot={current}
              onReload={reload}
              onClose={() => {
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
              onClose={() => {
                setEntryAction(null);
                reload();
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <div className="space-y-2">
        <p>{message}</p>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
