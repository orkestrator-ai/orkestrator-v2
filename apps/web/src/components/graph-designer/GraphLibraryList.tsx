import { Loader2, RefreshCw, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import {
  graphTemplateRefKey,
  type GraphProjectTemplateSource,
  type GraphTemplateRef,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import { Button } from "@/components/ui/button";
import type { GraphDesignerLibrary } from "@/stores/graphDesignerStore";
import { cn } from "@/lib/utils";

/**
 * The template library (item 109's list): built-in, user and project
 * templates. Built-ins run on their own engines (D5), so their row says
 * which, and a retired engine is marked; project templates show their trust
 * state with approve and revoke. Every row shows its compile counts.
 */

const ENGINE_LABELS: Record<string, string> = {
  "multi-review": "Multi Review",
  "build-pipeline": "Build Pipeline",
  "looped-review": "Looped Review",
};

const SECTIONS = [
  { scope: "builtin", title: "Built-in", label: "Built-in templates" },
  { scope: "user", title: "Yours", label: "Your templates" },
  { scope: "project", title: "Project", label: "Project templates" },
] as const;

function TrustBadge({ summary }: { summary: GraphTemplateSummary }) {
  if (summary.scope !== "project") return null;
  const { trust } = summary;
  const Icon = trust === "trusted" ? ShieldCheck : trust === "changed" ? ShieldAlert : ShieldX;
  return (
    <span
      data-graph-trust={trust}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1 text-[10px] leading-4",
        trust === "trusted"
          ? "border-emerald-500/40 text-emerald-300"
          : "border-amber-500/40 text-amber-300",
      )}
      title={
        trust === "trusted"
          ? `Approved${summary.approvedAt ? ` ${summary.approvedAt}` : ""}`
          : trust === "changed"
            ? "Changed since it was approved: untrusted until you approve it again"
            : "Not approved: it cannot launch until you approve it"
      }
    >
      <Icon aria-hidden className="size-3" />
      {trust === "trusted" ? "Trusted" : trust === "changed" ? "Changed" : "Untrusted"}
    </span>
  );
}

function EngineBadge({ summary }: { summary: GraphTemplateSummary }) {
  if (summary.scope !== "builtin" || !summary.engine) return null;
  const engine = ENGINE_LABELS[summary.engine] ?? summary.engine;
  const retired = summary.engineStatus === "retired";
  return (
    <span
      data-graph-engine-status={summary.engineStatus ?? "active"}
      className={cn(
        "rounded border px-1 text-[10px] leading-4",
        retired
          ? "border-zinc-500/50 text-zinc-400 line-through"
          : "border-sky-500/40 text-sky-300",
      )}
      title={
        retired
          ? `${engine}'s engine was retired: duplicate this template to run it as a graph`
          : `Runs on the ${engine} engine; duplicate it to run a copy as a graph`
      }
    >
      {retired ? "Retired engine" : `${engine} engine`}
    </span>
  );
}

function CompileBadge({ summary }: { summary: GraphTemplateSummary }) {
  const { errors, warnings } = summary.compile;
  if (errors === 0 && warnings === 0) {
    return <span className="text-[10px] text-muted-foreground">compiles</span>;
  }
  return (
    <span className="flex items-center gap-1 text-[10px] tabular-nums">
      {errors > 0 ? <span className="text-failure">{errors} err</span> : null}
      {warnings > 0 ? <span className="text-amber-300">{warnings} warn</span> : null}
    </span>
  );
}

function ProjectSourceNote({ source }: { source: GraphProjectTemplateSource | null }) {
  if (!source) return <p className="px-2 text-[11px] text-muted-foreground">No project.</p>;
  if (source.status === "no-checkout") {
    return (
      <p className="px-2 text-[11px] text-muted-foreground">
        This project has no local checkout on this machine.
      </p>
    );
  }
  if (source.status === "unavailable") {
    return <p className="px-2 text-[11px] text-failure">{source.directory} could not be read.</p>;
  }
  return (
    <>
      {source.files === 0 ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          No templates in <span className="font-mono">{source.directory}</span>.
        </p>
      ) : null}
      {source.problems.length > 0 ? (
        <ul data-graph-project-problems="" className="flex flex-col gap-0.5 px-2">
          {source.problems.map((problem) => (
            <li key={`${problem.path}:${problem.code}`} className="text-[11px] text-amber-300">
              <span className="font-mono">{problem.path}</span>: {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
      {source.truncated ? (
        <p className="px-2 text-[11px] text-muted-foreground">More files than the library reads.</p>
      ) : null}
    </>
  );
}

export function GraphLibraryList({
  library,
  selected,
  hasProject,
  onOpen,
  onRefresh,
  onTrust,
  trustBusy,
}: {
  library: GraphDesignerLibrary | undefined;
  selected: GraphTemplateRef | null;
  hasProject: boolean;
  onOpen: (summary: GraphTemplateSummary) => void;
  onRefresh: () => void;
  onTrust: (summary: GraphTemplateSummary, action: "approve" | "revoke") => void;
  trustBusy: string | null;
}) {
  const templates = library?.result?.templates ?? [];
  const selectedKey = selected ? graphTemplateRefKey(selected) : null;
  return (
    <nav aria-label="Graph templates" data-graph-library="" className="flex min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <h3 className="text-xs font-semibold text-foreground">Library</h3>
        {library?.status === "loading" ? (
          <Loader2 aria-hidden className="size-3 animate-spin text-muted-foreground" />
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          aria-label="Refresh the library"
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </header>
      {library?.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-failure">
          Could not load the library: {library.error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {SECTIONS.map(({ scope, title, label }) => {
          if (scope === "project" && !hasProject) return null;
          const rows = templates.filter((summary) => summary.scope === scope);
          return (
            <section key={scope} aria-label={label} className="pb-2">
              <h4 className="px-3 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {title}
              </h4>
              {scope === "project" ? (
                <ProjectSourceNote source={library?.result?.project ?? null} />
              ) : null}
              {rows.length === 0 && scope === "user" && library?.status === "ready" ? (
                <p className="px-3 text-[11px] text-muted-foreground">
                  None yet. Duplicate a template or import JSON.
                </p>
              ) : null}
              <ul className="flex flex-col">
                {rows.map((summary) => {
                  const key = graphTemplateRefKey(summary.ref);
                  const isSelected = key === selectedKey;
                  return (
                    <li key={key} data-graph-library-row={key}>
                      <button
                        type="button"
                        aria-current={isSelected ? "true" : undefined}
                        className={cn(
                          "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                          isSelected && "bg-accent",
                        )}
                        onClick={() => onOpen(summary)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-medium text-foreground">
                            {summary.name}
                          </span>
                          <span className="ml-auto shrink-0">
                            <CompileBadge summary={summary} />
                          </span>
                        </span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {summary.ref.scope === "project" ? summary.ref.path : summary.id}
                        </span>
                        <span className="flex flex-wrap items-center gap-1">
                          <EngineBadge summary={summary} />
                          <TrustBadge summary={summary} />
                          {summary.readOnly && summary.scope !== "builtin" ? (
                            <span className="text-[10px] text-muted-foreground">read-only</span>
                          ) : null}
                        </span>
                      </button>
                      {summary.scope === "project" ? (
                        <div className="flex gap-1 px-3 pb-1.5">
                          {summary.trust === "trusted" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={trustBusy === key}
                              onClick={() => onTrust(summary, "revoke")}
                            >
                              Revoke trust
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={trustBusy === key}
                              title="Approve this exact content (its digest); any later change needs approval again"
                              onClick={() => onTrust(summary, "approve")}
                            >
                              Approve
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
