import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { GraphTemplateCompileSummary } from "@orkestrator/protocol/graphs/library";
import type {
  GraphNodeList,
  GraphTemplateCapabilitySummary,
} from "@orkestrator/protocol/graphs/sharing";
import { cn } from "@/lib/utils";

/**
 * What a template would be allowed to do (item 405), shown before a person
 * trusts it: in the bundle import preview and in the project template
 * review. Side effects and taint are called out; nothing here is editable.
 */

function Nodes({ list }: { list: GraphNodeList }) {
  if (list.nodes.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="font-mono">
      {list.nodes.join(", ")}
      {list.more > 0 ? <span className="text-muted-foreground"> and {list.more} more</span> : null}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function GraphCompileCounts({ compile }: { compile: GraphTemplateCompileSummary }) {
  return (
    <span data-graph-review-compile="" className="flex flex-wrap gap-2 text-xs tabular-nums">
      {compile.errors > 0 ? (
        <span className="text-failure">{compile.errors} errors</span>
      ) : (
        <span className="text-emerald-300">compiles</span>
      )}
      {compile.warnings > 0 ? (
        <span className="text-amber-300">{compile.warnings} warnings</span>
      ) : null}
      {compile.pendingAcknowledgements > 0 ? (
        <span className="text-amber-300">{compile.pendingAcknowledgements} need acknowledging</span>
      ) : null}
      {compile.cost ? (
        <span className="text-muted-foreground">
          {compile.cost.agentSessions.best === compile.cost.agentSessions.worst
            ? compile.cost.agentSessions.worst
            : `${compile.cost.agentSessions.best}–${compile.cost.agentSessions.worst}`}{" "}
          agent sessions
        </span>
      ) : null}
    </span>
  );
}

export function GraphCapabilitySummaryView({
  summary,
  className,
}: {
  summary: GraphTemplateCapabilitySummary;
  className?: string;
}) {
  const sideEffects = summary.systemActions.filter((action) => action.sideEffect);
  return (
    <section
      data-graph-capability-summary=""
      aria-label="What this template may do"
      className={cn("flex flex-col gap-2 text-xs", className)}
    >
      {summary.remoteWriteRequests.nodes.length > 0 ? (
        <p role="alert" className="flex items-start gap-1.5 text-failure">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Asks for push or GitHub writes on agent nodes (always refused):{" "}
            <Nodes list={summary.remoteWriteRequests} />
          </span>
        </p>
      ) : null}
      {summary.taint.length > 0 ? (
        <div data-graph-capability-taint="" className="flex flex-col gap-1 text-amber-300">
          {summary.taint.map((entry) => (
            <p key={entry.node} className="flex items-start gap-1.5">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Untrusted content from{" "}
                <span className="font-mono">{entry.sources.join(", ") || entry.node}</span> can
                reach <span className="font-mono">{entry.node}</span> ({entry.sideEffect}).
              </span>
            </p>
          ))}
        </div>
      ) : null}
      <dl className="flex flex-col gap-1">
        <Row label="Agent nodes">
          {summary.agentNodes === 0 ? (
            <span className="text-muted-foreground">none</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {summary.profiles.map((entry) => (
                <li key={entry.profile}>
                  <span className="font-medium">{entry.profile}</span>: <Nodes list={entry} />
                </li>
              ))}
            </ul>
          )}
        </Row>
        {summary.allowed.length > 0 ? (
          <Row label="Added capabilities">
            <ul className="flex flex-col gap-0.5">
              {summary.allowed.map((entry) => (
                <li key={entry.capability}>
                  <span className="font-mono">{entry.capability}</span>: <Nodes list={entry} />
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
        <Row label="Write the workspace">
          <Nodes list={summary.workspaceWriters} />
        </Row>
        {summary.networkNodes ? (
          <Row label="Network or search">
            <Nodes list={summary.networkNodes} />
          </Row>
        ) : null}
        {summary.orkestratorGroups.length > 0 ? (
          <Row label="Orkestrator tools">
            <span className="font-mono">{summary.orkestratorGroups.join(", ")}</span>
          </Row>
        ) : null}
        <Row label="System actions">
          {summary.systemActions.length === 0 ? (
            <span className="text-muted-foreground">none</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {summary.systemActions.map((entry) => (
                <li key={entry.action} data-graph-capability-action={entry.action}>
                  <span className={cn("font-medium", entry.sideEffect && "text-amber-300")}>
                    {entry.label}
                  </span>
                  {entry.sideEffect ? (
                    <span className="text-muted-foreground"> (changes things outside the run)</span>
                  ) : null}
                  : <Nodes list={entry} />
                </li>
              ))}
            </ul>
          )}
        </Row>
        {summary.subgraphs.nodes.length > 0 ? (
          <Row label="Sub-graphs">
            <Nodes list={summary.subgraphs} />
          </Row>
        ) : null}
        <Row label="People">
          {summary.humanNodes} human node{summary.humanNodes === 1 ? "" : "s"}
          {summary.askHuman.nodes.length > 0 ? (
            <>
              ; may ask: <Nodes list={summary.askHuman} />
            </>
          ) : null}
        </Row>
        {summary.removedByCeiling.length > 0 ? (
          <Row label="Removed by ceiling">
            <ul className="flex flex-col gap-0.5">
              {summary.removedByCeiling.map((entry) => (
                <li key={entry.node}>
                  <span className="font-mono">{entry.node}</span>: {entry.capabilities.join(", ")}
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
      </dl>
      {summary.taintWarnings.length > 0 ? (
        <ul data-graph-capability-taint-warnings="" className="flex flex-col gap-0.5">
          {summary.taintWarnings.map((warning, index) => (
            <li key={`${warning.code}:${index}`} className="text-amber-300">
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}
      {!summary.compiled ? (
        <p className="text-muted-foreground">
          The template has compile errors, so network access, ceiling removals and taint are not
          shown.
        </p>
      ) : null}
      {sideEffects.length === 0 && summary.workspaceWriters.nodes.length === 0 ? (
        <p className="text-muted-foreground">
          No node changes the workspace or anything outside it.
        </p>
      ) : null}
    </section>
  );
}
