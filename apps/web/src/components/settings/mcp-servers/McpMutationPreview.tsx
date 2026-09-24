import type { McpImpactPreview } from "@orkestrator/protocol/mcp-management";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";

/** What a change will do, shown before anything is written. */
export function McpMutationPreview({ preview }: { preview: McpImpactPreview }) {
  return (
    <div
      className="space-y-3 rounded-md border border-white/10 bg-zinc-900/45 p-3 text-sm"
      aria-label="Change preview"
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Saved to</dt>
        <dd className="min-w-0">
          <span className="text-foreground">{preview.sourceLabel}</span>
          <span className="ml-2 break-all font-mono text-muted-foreground">
            {preview.displayPath}
          </span>
        </dd>
        <dt className="text-muted-foreground">Changes</dt>
        <dd className="text-foreground">
          {preview.changedFields.length ? preview.changedFields.join(", ") : "No changes"}
        </dd>
        <dt className="text-muted-foreground">Applies</dt>
        <dd className="text-foreground">{preview.apply.description}</dd>
        {preview.sharedWith.length ? (
          <>
            <dt className="text-muted-foreground">Also read by</dt>
            <dd className="text-foreground">
              {preview.sharedWith.map((provider) => AGENT_PLATFORM_LABELS[provider]).join(", ")}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Environments</dt>
        <dd className="text-foreground">
          {preview.affectedEnvironments.length
            ? preview.affectedEnvironments
                .map(
                  (environment) =>
                    `${environment.name}${environment.activeSessions ? ` (${environment.activeSessions} busy)` : ""}`,
                )
                .join(", ")
            : "No open sessions use this file right now. External terminals and IDEs may still read it."}
        </dd>
      </dl>
      {preview.revealsEntryId ? (
        <p className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200">
          The same-name server from {preview.revealsSourceLabel} will become effective.
        </p>
      ) : null}
      {preview.shadowsEntryId ? (
        <p className="rounded border border-blue-500/20 bg-blue-500/5 px-2 py-1.5 text-xs text-blue-200">
          This overrides the same-name server from {preview.shadowsSourceLabel}.
        </p>
      ) : null}
      {preview.warnings.length ? (
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
