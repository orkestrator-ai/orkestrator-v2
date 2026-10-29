import { useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphGuardResult, GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatTokenCount } from "@/lib/context-usage";
import { GraphActivationTranscript } from "./GraphActivationTranscript";
import {
  GraphArtifactCard,
  graphArtifactRendering,
  graphArtifactTypeDefinition,
} from "./GraphArtifactView";
import { GraphHumanNodePanel, type GraphHumanNodeAnswer } from "./GraphHumanNodePanel";
import { GraphQuestionAnswerForm, type GraphQuestionAnswer } from "./GraphQuestionAnswerForm";
import { graphRunTruncationText, type GraphRunFlowNode } from "./graph-run-flow";

/**
 * The body of the run view's inspector for the selected node (plan P2.11,
 * report §7.7): what the node waits on (an agent's question, a human
 * decision), its error, the profile and the enforcement tier it actually
 * ran under with the reason, guard results, usage, the input and output
 * artifacts rendered by their types, provisional `report_progress` items,
 * earlier attempts, and the agent's transcript.
 */

const ENFORCEMENT_WORDS = {
  enforced: "Enforced",
  "provider-configured": "Provider-configured",
  advisory: "Advisory",
} as const;

const GUARD_WORDS = {
  "read-only": "Read-only guard",
  "remote-ref": "Remote-ref guard",
  enforcement: "Enforcement check",
} as const;

function planNodeOf(run: GraphRun, nodeId: string | undefined): GraphPlanNode | undefined {
  return nodeId ? run.plan.nodes.find((node) => node.id === nodeId) : undefined;
}

function formatWhen(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function GuardRow({ guard }: { guard: GraphGuardResult }) {
  const Icon =
    guard.outcome === "passed"
      ? ShieldCheck
      : guard.outcome === "violated"
        ? ShieldAlert
        : ShieldQuestion;
  return (
    <li
      data-graph-guard={guard.guard}
      data-graph-guard-outcome={guard.outcome}
      className="flex min-w-0 flex-col gap-0.5 text-xs"
    >
      <span className="flex items-center gap-1.5">
        <Icon
          aria-hidden
          className={cn(
            "size-3.5",
            guard.outcome === "passed"
              ? "text-success"
              : guard.outcome === "violated"
                ? "text-failure"
                : "text-amber-400",
          )}
        />
        <span className="font-medium">{GUARD_WORDS[guard.guard]}</span>
        <span className="text-muted-foreground">{guard.outcome}</span>
      </span>
      {guard.detail ? <span className="text-muted-foreground">{guard.detail}</span> : null}
      {guard.paths?.length ? (
        <ul className="ml-5 list-disc font-mono text-[11px] text-muted-foreground">
          {guard.paths.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PortArtifacts({
  run,
  ports,
  defaultOpen,
}: {
  run: GraphRun;
  ports: Record<string, string | string[]>;
  defaultOpen: boolean;
}) {
  const entries = Object.entries(ports);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">None</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {entries.flatMap(([port, ids]) => {
        const list = Array.isArray(ids) ? ids : [ids];
        return list.map((id, index) => (
          <GraphArtifactCard
            key={`${port}:${id}`}
            runId={run.id}
            artifactId={id}
            plan={run.plan}
            label={list.length > 1 ? `${port} [${index + 1}]` : port}
            defaultOpen={defaultOpen && list.length === 1}
          />
        ));
      })}
    </div>
  );
}

function ProgressItems({ run, activation }: { run: GraphRun; activation: NodeActivation }) {
  const progress = activation.session?.progress ?? [];
  const planNode = planNodeOf(run, activation.nodeId);
  if (progress.length === 0 || activation.state === "complete") return null;
  return (
    <Section title={`Reported so far (${progress.length}, provisional)`}>
      <ul className="flex min-w-0 flex-col gap-1.5" data-graph-progress="">
        {progress.map((entry) => {
          const port = planNode?.outputs.find((output) => output.name === entry.port);
          const definition = port ? graphArtifactTypeDefinition(run.plan, port.type) : null;
          const item = definition?.itemType
            ? graphArtifactTypeDefinition(run.plan, definition.itemType)
            : null;
          const rendering = graphArtifactRendering(item, entry.item);
          return (
            <li key={entry.id} className="min-w-0 rounded-md border border-dashed p-2 text-xs">
              <span className="text-muted-foreground">{entry.port}</span>
              {rendering.kind === "summary" ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-2">
                  {rendering.rows.map((row) => (
                    <div key={row.field} className="contents">
                      <dt className="font-mono text-muted-foreground">{row.field}</dt>
                      <dd className="break-words">{row.text}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <pre className="max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                  {rendering.kind === "json" || rendering.kind === "markdown"
                    ? rendering.text
                    : JSON.stringify(entry.item, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ActivationDetails({
  run,
  node,
  activation,
  onAnswer,
  onHumanAnswer,
}: {
  run: GraphRun;
  node: GraphRunFlowNode;
  activation: NodeActivation;
  onAnswer: (activation: NodeActivation, answer: GraphQuestionAnswer) => Promise<void>;
  onHumanAnswer?: (activation: NodeActivation, answer: GraphHumanNodeAnswer) => Promise<void>;
}) {
  const planNode = planNodeOf(run, activation.nodeId);
  const session = activation.session;
  const question = session?.question;
  const profile = planNode?.kind === "agent" ? planNode.capabilities.spec.profile : undefined;
  const runOpen =
    run.status !== "complete" && run.status !== "failed" && run.status !== "cancelled";
  return (
    <div className="flex min-w-0 flex-col gap-4" data-graph-activation={activation.key}>
      {question ? (
        <GraphQuestionAnswerForm
          question={question}
          asker={node.title}
          disabled={
            !runOpen || run.status === "cancelling" || activation.state !== "awaiting-human"
          }
          onSubmit={(answer) => onAnswer(activation, answer)}
        />
      ) : null}
      {planNode?.kind === "human" ? (
        <GraphHumanNodePanel
          run={run}
          node={planNode}
          activation={activation}
          disabled={!runOpen || run.status === "cancelling"}
          {...(onHumanAnswer ? { onAnswer: onHumanAnswer } : {})}
        />
      ) : null}
      {node.item || (node.fanOut && node.fanOut.total > node.fanOut.running) ? (
        <Section title="Item">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-graph-item="">
            {node.item ? (
              <>
                <dt className="text-muted-foreground">Item</dt>
                <dd className="break-all">
                  {node.item.index} · <span className="font-mono">{node.item.id}</span>
                </dd>
              </>
            ) : null}
            {node.fanOut && node.fanOut.total > node.fanOut.running ? (
              <>
                <dt className="text-muted-foreground">Fan-out</dt>
                <dd className="text-amber-300" data-graph-item-truncated="">
                  {graphRunTruncationText(node.fanOut)}
                </dd>
              </>
            ) : null}
          </dl>
        </Section>
      ) : null}
      {activation.error ? (
        <Section title="Error">
          <p
            role="status"
            data-graph-activation-error=""
            className="text-xs break-words whitespace-pre-wrap text-failure"
          >
            {activation.error}
            {activation.errorCause ? (
              <span className="text-muted-foreground"> ({activation.errorCause})</span>
            ) : null}
          </p>
        </Section>
      ) : null}
      {activation.policy || profile || activation.enforcement ? (
        <Section title="Capabilities">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {profile ? (
              <>
                <dt className="text-muted-foreground">Profile</dt>
                <dd data-graph-profile="">{profile}</dd>
              </>
            ) : null}
            {activation.enforcement ? (
              <>
                <dt className="text-muted-foreground">Enforcement</dt>
                <dd data-graph-enforcement={activation.enforcement}>
                  {ENFORCEMENT_WORDS[activation.enforcement]}
                  {activation.enforcementReason ? (
                    <span className="text-muted-foreground"> — {activation.enforcementReason}</span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {activation.policy ? (
              <>
                <dt className="text-muted-foreground">Sandbox</dt>
                <dd>
                  {activation.policy.sandbox} · network {activation.policy.networkAccess} ·
                  approvals {activation.policy.approvals}
                </dd>
              </>
            ) : null}
            {session?.turnMode ? (
              <>
                <dt className="text-muted-foreground">Turn</dt>
                <dd>{session.turnMode === "read-only" ? "Read-only turn" : "Build turn"}</dd>
              </>
            ) : null}
            {session?.commandSandboxOff ? (
              <>
                <dt className="text-muted-foreground">Commands</dt>
                <dd className="text-amber-300">
                  Ran without the provider sandbox: {session.commandSandboxOff}
                </dd>
              </>
            ) : null}
          </dl>
        </Section>
      ) : null}
      {activation.guards?.length ? (
        <Section title="Guards">
          <ul className="flex flex-col gap-1.5">
            {activation.guards.map((guard, index) => (
              <GuardRow key={`${guard.guard}-${index}`} guard={guard} />
            ))}
          </ul>
        </Section>
      ) : null}
      {session ? (
        <Section title="Session">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">Agent</dt>
            <dd>{[session.agent, session.model, session.effort].filter(Boolean).join(" · ")}</dd>
            {session.tokenCount !== undefined ? (
              <>
                <dt className="text-muted-foreground">Tokens</dt>
                <dd data-graph-usage="">
                  {formatTokenCount(session.tokenCount)}
                  {session.cacheReadTokens
                    ? ` (${formatTokenCount(session.cacheReadTokens)} cache reads)`
                    : ""}
                </dd>
              </>
            ) : null}
            {formatWhen(activation.startedAt) ? (
              <>
                <dt className="text-muted-foreground">Started</dt>
                <dd>{formatWhen(activation.startedAt)}</dd>
              </>
            ) : null}
            {formatWhen(activation.finishedAt) ? (
              <>
                <dt className="text-muted-foreground">Finished</dt>
                <dd>{formatWhen(activation.finishedAt)}</dd>
              </>
            ) : null}
          </dl>
        </Section>
      ) : null}
      <ProgressItems run={run} activation={activation} />
      <Section title="Outputs">
        <PortArtifacts run={run} ports={activation.outputs} defaultOpen />
      </Section>
      <Section title="Inputs">
        <PortArtifacts run={run} ports={activation.inputs} defaultOpen={false} />
      </Section>
    </div>
  );
}

export function GraphRunInspector({
  run,
  node,
  environmentId,
  containerId,
  isActive,
  ownsGlobalShortcuts,
  onAnswer,
  onHumanAnswer,
  onSelectActivation,
}: {
  run: GraphRun;
  node: GraphRunFlowNode;
  environmentId: string;
  containerId: string | undefined;
  isActive: boolean;
  ownsGlobalShortcuts: boolean;
  onAnswer: (activation: NodeActivation, answer: GraphQuestionAnswer) => Promise<void>;
  /** Answers a waiting human node (item 208). */
  onHumanAnswer?: (activation: NodeActivation, answer: GraphHumanNodeAnswer) => Promise<void>;
  /** Selects a superseded activation of a previous attempt (expanding it). */
  onSelectActivation: (attemptId: string, activationKey: string) => void;
}) {
  // An earlier attempt of the position the reader picked; the newest by default.
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const attempts = node.attempts;
  const activation = useMemo(
    () =>
      (attemptKey ? attempts.find((candidate) => candidate.key === attemptKey) : undefined) ??
      node.activation,
    [attemptKey, attempts, node.activation],
  );
  const hasTranscript = Boolean(activation?.session);
  const [view, setView] = useState<"details" | "transcript">(() =>
    activation?.session && !activation.session.question && activation.state !== "awaiting-human"
      ? "transcript"
      : "details",
  );
  const shownView = hasTranscript ? view : "details";

  if (node.kind === "inputs") {
    const params = Object.entries(run.bindings.params);
    return (
      <div className="flex min-w-0 flex-col gap-4 overflow-y-auto pb-4">
        <Section title="Run inputs">
          <PortArtifacts run={run} ports={run.bindings.inputs} defaultOpen />
        </Section>
        {params.length > 0 ? (
          <Section title="Parameters">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {params.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-muted-foreground">{key}</dt>
                  <dd className="break-words">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}
      </div>
    );
  }

  if (node.kind === "attempt") {
    const keys = new Set(node.attemptActivationKeys ?? []);
    const superseded = run.activations.filter((candidate) => keys.has(candidate.key));
    const rewind = run.rewinds.find((entry) => entry.id === node.attemptId);
    return (
      <div className="flex min-w-0 flex-col gap-3 overflow-y-auto pb-4 text-sm">
        <p className="text-muted-foreground">
          {rewind
            ? `${rewind.kind === "rewind-code" ? "A code rewind" : "A restart"} of ${rewind.nodeId} (requested by the ${rewind.requestedBy}${formatWhen(rewind.requestedAt) ? `, ${formatWhen(rewind.requestedAt)}` : ""}) superseded these activations. They stay readable here.`
            : "These activations were superseded. They stay readable here."}
        </p>
        <ul className="flex flex-col gap-1">
          {superseded.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className="w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-elevated"
                onClick={() => onSelectActivation(node.attemptId!, entry.key)}
              >
                {entry.key}
                {entry.error ? <span className="text-failure"> · failed</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!activation) {
    const planNode = planNodeOf(run, node.nodeId);
    return (
      <div className="flex min-w-0 flex-col gap-3 pb-4 text-sm text-muted-foreground">
        <p>
          {node.placeholder &&
          (run.status === "complete" || run.status === "failed" || run.status === "cancelled")
            ? "The run did not reach this node."
            : "This node has not started: it waits for its inputs."}
        </p>
        {planNode?.description ? <p>{planNode.description}</p> : null}
        {planNode?.kind === "human" ? (
          <GraphHumanNodePanel run={run} node={planNode} activation={undefined} disabled />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {hasTranscript ? (
          <Tabs
            value={shownView}
            onValueChange={(value) => setView(value as "details" | "transcript")}
          >
            <TabsList aria-label="Inspector views" className="h-7 rounded-md p-0.5">
              <TabsTrigger className="h-6 px-2 text-xs" value="details">
                Details
              </TabsTrigger>
              <TabsTrigger className="h-6 px-2 text-xs" value="transcript">
                Transcript
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
        {attempts.length > 1 ? (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            Attempt
            <select
              className="rounded border border-border bg-background px-1 py-0.5 text-xs"
              value={activation.key}
              onChange={(event) =>
                setAttemptKey(
                  event.target.value === node.activation?.key ? null : event.target.value,
                )
              }
            >
              {attempts.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.attempt} · {entry.state}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {shownView === "transcript" ? (
        <GraphActivationTranscript
          key={activation.key}
          runId={run.id}
          environmentId={environmentId}
          containerId={containerId}
          activation={activation}
          isActive={isActive}
          ownsGlobalShortcuts={ownsGlobalShortcuts}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <ActivationDetails
            run={run}
            node={node}
            activation={activation}
            onAnswer={onAnswer}
            {...(onHumanAnswer ? { onHumanAnswer } : {})}
          />
        </div>
      )}
    </div>
  );
}
