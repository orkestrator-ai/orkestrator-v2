import { useState } from "react";
import { FileWarning, Lock, Pencil, Power, TextCursorInput, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type {
  McpCapabilityFlag,
  McpConfigSource,
  McpDefinitionStatus,
  McpDefinitionSummary,
  McpManagementSnapshot,
} from "@orkestrator/protocol/mcp-management";

import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";

import { describeMcpError, newRequestId } from "./useMcpManagement";

const STATUS_TEXT: Record<McpDefinitionStatus, string> = {
  effective: "In use",
  shadowed: "Overridden",
  disabled: "Disabled",
  "policy-excluded": "Excluded here",
  invalid: "Needs repair",
  unsupported: "Not editable here",
  protected: "Managed by Orkestrator",
};

const STATUS_TONE: Record<McpDefinitionStatus, string> = {
  effective: "border-emerald-500/30 text-emerald-300",
  shadowed: "border-white/15 text-muted-foreground",
  disabled: "border-white/15 text-muted-foreground",
  "policy-excluded": "border-amber-500/30 text-amber-300",
  invalid: "border-red-500/30 text-red-300",
  unsupported: "border-amber-500/30 text-amber-300",
  protected: "border-blue-500/30 text-blue-300",
};

const SOURCE_STATE_TEXT: Record<McpConfigSource["state"], string | null> = {
  ok: null,
  absent: "No file yet; adding a server creates it.",
  invalid: "Could not be read",
  oversized: "Too large to edit safely",
  "permission-denied": "Permission denied",
  "unsupported-layout": "Uses a layout this editor cannot change",
  offline: "Not reachable",
};

function ActionButton({
  flag,
  label,
  icon,
  onClick,
  highlight,
}: {
  flag: McpCapabilityFlag;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  highlight?: boolean;
}) {
  if (!flag.supported && !flag.reason) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("h-7 gap-1 px-2 text-xs", highlight && "text-foreground")}
      disabled={!flag.supported}
      title={flag.supported ? undefined : flag.reason}
      aria-label={flag.supported ? label : `${label} (unavailable: ${flag.reason})`}
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label.split(" ")[0]}</span>
    </Button>
  );
}

function DefinitionRow({
  definition,
  snapshot,
  highlighted,
  onEdit,
  onRename,
  onRemove,
}: {
  definition: McpDefinitionSummary;
  snapshot: McpManagementSnapshot;
  highlighted: boolean;
  onEdit: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const source = snapshot.sources.find((candidate) => candidate.sourceId === definition.sourceId);
  const location =
    definition.transport === "stdio" && definition.command
      ? `${definition.command.kind === "visible" ? definition.command.value : definition.command.display}${definition.argCount ? ` +${definition.argCount} args` : ""}`
      : definition.url
        ? definition.url.kind === "visible"
          ? definition.url.value
          : definition.url.display
        : "";
  const shadowedBy = definition.shadowedBy
    ? snapshot.definitions.find((candidate) => candidate.entryId === definition.shadowedBy)
    : undefined;
  const toggle = async () => {
    if (!source?.revision) return;
    setToggling(true);
    try {
      await backend.mutateMcpDefinition({
        requestId: newRequestId(),
        targetId: snapshot.target.targetId,
        applyIntent: "save",
        operation: {
          kind: "set-enabled",
          entryId: definition.entryId,
          expectedRevision: source.revision,
          enabled: definition.enabled === false,
        },
      });
    } catch (error) {
      toast.error(describeMcpError(error));
    } finally {
      setToggling(false);
    }
  };
  return (
    <li
      className={cn(
        "flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3",
        highlighted && "bg-blue-500/10",
      )}
      aria-label={`${definition.name}, ${STATUS_TEXT[definition.status]}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-sm text-foreground">{definition.name}</span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[11px]",
              STATUS_TONE[definition.status],
            )}
          >
            {STATUS_TEXT[definition.status]}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {definition.transport}
          </span>
          {definition.secretCount ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden="true" />
              {definition.secretCount} saved {definition.secretCount === 1 ? "value" : "values"}
            </span>
          ) : null}
        </div>
        {location ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{location}</p>
        ) : null}
        {definition.statusReason && definition.status !== "effective" ? (
          <p className="text-xs text-muted-foreground">
            {definition.statusReason}
            {shadowedBy && shadowedBy.name !== definition.name ? ` (${shadowedBy.name})` : ""}
          </p>
        ) : null}
      </div>
      {definition.status !== "protected" ? (
        <div className="flex shrink-0 flex-wrap gap-0.5">
          <ActionButton
            flag={definition.actions.edit}
            label={`Edit ${definition.name}`}
            icon={<Pencil className="h-3.5 w-3.5" />}
            onClick={onEdit}
          />
          <ActionButton
            flag={definition.actions.rename}
            label={`Rename ${definition.name}`}
            icon={<TextCursorInput className="h-3.5 w-3.5" />}
            onClick={onRename}
          />
          {definition.enabled !== null ? (
            <ActionButton
              flag={
                toggling ? { supported: false, reason: "Saving…" } : definition.actions.setEnabled
              }
              label={`${definition.enabled ? "Disable" : "Enable"} ${definition.name}`}
              icon={<Power className="h-3.5 w-3.5" />}
              onClick={() => void toggle()}
            />
          ) : null}
          <ActionButton
            flag={definition.actions.remove}
            label={`Remove ${definition.name}`}
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onRemove}
          />
        </div>
      ) : null}
    </li>
  );
}

export function McpSourceList({
  snapshot,
  highlightName,
  onEdit,
  onRename,
  onRemove,
}: {
  snapshot: McpManagementSnapshot;
  highlightName?: string;
  onEdit: (definition: McpDefinitionSummary) => void;
  onRename: (definition: McpDefinitionSummary) => void;
  onRemove: (definition: McpDefinitionSummary) => void;
}) {
  const sources = [...snapshot.sources].sort((left, right) => right.precedence - left.precedence);
  return (
    <div className="space-y-3">
      {sources.map((source) => {
        const definitions = snapshot.definitions.filter(
          (definition) => definition.sourceId === source.sourceId,
        );
        const stateText = SOURCE_STATE_TEXT[source.state];
        const broken =
          source.state === "invalid" ||
          source.state === "permission-denied" ||
          source.state === "oversized";
        return (
          <section
            key={source.sourceId}
            className="rounded-lg border border-white/10 bg-zinc-900/40"
            aria-label={source.label}
          >
            <header className="flex flex-col gap-0.5 border-b border-white/10 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-foreground">{source.label}</h3>
                {!source.writable && source.format !== "runtime" ? (
                  <span className="text-[11px] text-muted-foreground" title={source.readOnlyReason}>
                    Read-only
                  </span>
                ) : null}
                {source.sharedWith.length ? (
                  <span className="text-[11px] text-muted-foreground">
                    Also read by{" "}
                    {source.sharedWith
                      .map((provider) => AGENT_PLATFORM_LABELS[provider])
                      .join(", ")}
                  </span>
                ) : null}
              </div>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {source.displayPath}
              </p>
              {stateText ? (
                <p
                  className={cn(
                    "flex items-center gap-1 text-xs",
                    broken ? "text-red-300" : "text-muted-foreground",
                  )}
                >
                  {broken ? <FileWarning className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  {stateText}
                  {source.error ? `: ${source.error}` : ""}
                </p>
              ) : null}
              {source.trust && source.trust !== "allowed" && source.trustReason ? (
                <p className="text-xs text-amber-300">{source.trustReason}</p>
              ) : null}
              {!source.writable && source.readOnlyReason && source.format !== "runtime" ? (
                <p className="text-xs text-muted-foreground">{source.readOnlyReason}</p>
              ) : null}
            </header>
            {definitions.length ? (
              <ul className="divide-y divide-white/5">
                {definitions.map((definition) => (
                  <DefinitionRow
                    key={definition.entryId}
                    definition={definition}
                    snapshot={snapshot}
                    highlighted={highlightName === definition.name}
                    onEdit={() => onEdit(definition)}
                    onRename={() => onRename(definition)}
                    onRemove={() => onRemove(definition)}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {broken
                  ? "Servers in this file cannot be listed until it is repaired."
                  : "No servers."}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
