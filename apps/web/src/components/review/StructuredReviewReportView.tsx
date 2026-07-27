import { useState } from "react";
import type {
  ReviewIssue,
  StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileWarning,
  ShieldCheck,
  TestTube2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const severityStyles: Record<ReviewIssue["severity"], string> = {
  P0: "border-red-500/40 bg-red-500/8 text-red-300",
  P1: "border-amber-500/40 bg-amber-500/8 text-amber-300",
  P2: "border-sky-500/35 bg-sky-500/8 text-sky-300",
};

function location(file: string, line: number | null): string {
  return line ? `${file}:${line}` : file;
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/70 py-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function EmptyLine({ children = "None." }: { children?: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function List({
  items,
  render,
}: {
  items: readonly unknown[];
  render: (value: unknown, index: number) => React.ReactNode;
}) {
  if (items.length === 0) return <EmptyLine />;
  return (
    <ul className="space-y-1.5 text-sm text-foreground/90">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span className="mt-[0.55rem] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
          <span className="min-w-0">{render(item, index)}</span>
        </li>
      ))}
    </ul>
  );
}

export interface StructuredReviewReportViewProps {
  report: StructuredReviewReport;
  className?: string;
  heading?: string;
}

export function StructuredReviewReportView({
  report,
  className,
  heading = "Structured review report",
}: StructuredReviewReportViewProps) {
  const [showRaw, setShowRaw] = useState(false);
  const scope = report.reviewScope;
  const changed = report.whatChanged;
  const notRun = report.testResults.notRun
    ?? Math.max(
      0,
      report.testResults.total
        - report.testResults.passed
        - report.testResults.failed,
    );

  return (
    <article
      className={cn(
        "rounded-xl border border-border/80 bg-card/45 p-4 shadow-sm @sm:p-5",
        className,
      )}
      aria-label={heading}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-cyan-400/80">
            Validated JSON Schema
          </p>
          <h2 className="mt-1 text-base font-semibold text-foreground">{heading}</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((value) => !value)}
        >
          <Braces className="size-3.5" />
          {showRaw ? "Hide raw JSON" : "Inspect raw JSON"}
          {showRaw
            ? <ChevronDown className="size-3.5" />
            : <ChevronRight className="size-3.5" />}
        </Button>
      </div>

      {showRaw && (
        <pre
          className="mb-5 max-h-96 overflow-auto rounded-lg border border-border bg-background/80 p-3 text-xs leading-relaxed text-foreground/80"
          tabIndex={0}
          aria-label="Raw structured review JSON"
        >
          {JSON.stringify(report, null, 2)}
        </pre>
      )}

      <Section title="Review Scope">
        <dl className="grid gap-x-5 gap-y-2 text-sm @md:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Target branch</dt>
            <dd className="font-mono text-xs">{scope.targetBranch}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Base ref</dt>
            <dd className="break-all font-mono text-xs">{scope.baseRef}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Commit</dt>
            <dd className="text-xs">
              {scope.commit
                ? <><span className="font-mono">{scope.commit.sha}</span> — {scope.commit.subject}</>
                : "No commit created"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Files reviewed</dt>
            <dd>{scope.filesReviewed.length}</dd>
          </div>
        </dl>
        {(scope.commandsRun.length > 0 || scope.commandsNotRun.length > 0) && (
          <div className="mt-4 rounded-lg border border-border/70 bg-background/35 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">Validation commands</p>
            <List
              items={scope.commandsRun}
              render={(value) => {
                const command = value as (typeof scope.commandsRun)[number];
                return (
                  <>
                    <code className="text-xs">{command.command}</code>
                    {" — "}
                    <span className={command.result === "passed" ? "text-emerald-400" : "text-red-400"}>
                      {command.result}
                    </span>
                    {command.summary ? ` (${command.summary})` : ""}
                  </>
                );
              }}
            />
            <List
              items={scope.commandsNotRun}
              render={(value) => {
                const command = value as (typeof scope.commandsNotRun)[number];
                return <><code className="text-xs">{command.command}</code> — {command.reason}</>;
              }}
            />
          </div>
        )}
        {(scope.filesSkipped.length > 0
          || scope.filesLeftUncommitted.length > 0
          || scope.limitations.length > 0) && (
          <div className="mt-4 grid gap-3 @md:grid-cols-3">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Files skipped</p>
              <List
                items={scope.filesSkipped}
                render={(value) => {
                  const file = value as (typeof scope.filesSkipped)[number];
                  return <><code>{file.file}</code> — {file.reason}</>;
                }}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Left uncommitted</p>
              <List
                items={scope.filesLeftUncommitted}
                render={(value) => {
                  const file = value as (typeof scope.filesLeftUncommitted)[number];
                  return <><code>{file.file}</code> — {file.reason}</>;
                }}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Limitations</p>
              <List items={scope.limitations} render={(value) => String(value)} />
            </div>
          </div>
        )}
      </Section>

      <Section title="What Changed">
        <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
          <p>{changed.overview}</p>
          <dl className="grid gap-3 @md:grid-cols-2">
            <div className="rounded-lg border border-border/60 bg-background/30 p-3">
              <dt className="mb-1 text-xs font-medium text-muted-foreground">Before</dt>
              <dd>{changed.before}</dd>
            </div>
            <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
              <dt className="mb-1 text-xs font-medium text-cyan-300/80">After</dt>
              <dd>{changed.after}</dd>
            </div>
          </dl>
          <List
            items={changed.keyCodeChanges}
            render={(value) => {
              const change = value as (typeof changed.keyCodeChanges)[number];
              return <><code>{location(change.file, change.line)}</code> — {change.description}</>;
            }}
          />
          <p><span className="font-medium">User impact:</span> {changed.userImpact}</p>
        </div>
      </Section>

      <Section title="Risk Profile" icon={<ShieldCheck className="size-4 text-amber-400" />}>
        <div className="flex flex-wrap gap-2">
          <span className={cn(
            "rounded-full border px-2.5 py-1 text-xs font-medium capitalize",
            report.riskProfile.overallRisk === "high"
              ? "border-red-500/35 bg-red-500/8 text-red-300"
              : report.riskProfile.overallRisk === "medium"
                ? "border-amber-500/35 bg-amber-500/8 text-amber-300"
                : "border-emerald-500/30 bg-emerald-500/8 text-emerald-300",
          )}>
            {report.riskProfile.overallRisk} risk
          </span>
          {report.riskProfile.changeTypes.map((type) => (
            <span key={type} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
              {type}
            </span>
          ))}
          {report.riskProfile.riskAreas.map((area) => (
            <span key={area} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
              {area}
            </span>
          ))}
        </div>
        <p className="mt-3 text-sm text-foreground/85">{report.riskProfile.reasoning}</p>
      </Section>

      <Section title="Test Results" icon={<TestTube2 className="size-4 text-violet-400" />}>
        <div className="mb-3 flex flex-wrap gap-4 text-sm">
          <span>{report.testResults.total} total</span>
          <span className="text-emerald-400">{report.testResults.passed} passed</span>
          <span className={report.testResults.failed > 0 ? "text-red-400" : "text-muted-foreground"}>
            {report.testResults.failed} failed
          </span>
          <span className="text-muted-foreground">{notRun} not run</span>
        </div>
        <List
          items={report.testResults.failures}
          render={(value) => {
            const failure = value as (typeof report.testResults.failures)[number];
            return <><strong>{failure.testName}</strong> · <code>{failure.file}</code> — {failure.errorMessage}</>;
          }}
        />
      </Section>

      <Section title="Strengths" icon={<CheckCircle2 className="size-4 text-emerald-400" />}>
        <List
          items={report.strengths}
          render={(value) => {
            const strength = value as (typeof report.strengths)[number];
            return <>{strength.description} <code className="text-xs text-muted-foreground">{location(strength.file, strength.line)}</code></>;
          }}
        />
      </Section>

      <Section
        title={`Issues · ${report.issues.length}`}
        icon={<CircleAlert className="size-4 text-amber-400" />}
      >
        {report.issues.length === 0
          ? <EmptyLine>No high-confidence issues were found in the reviewed scope.</EmptyLine>
          : (
            <ol className="space-y-3">
              {report.issues.map((issue, index) => (
                <li
                  key={`${issue.file}-${issue.line}-${issue.title}-${index}`}
                  className={cn("rounded-lg border p-3.5", severityStyles[issue.severity])}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-background/35 px-1.5 py-0.5 font-mono text-xs font-semibold">
                      {issue.severity}
                    </span>
                    <span className="text-xs">{issue.confidence}% confidence</span>
                    <span className="text-xs opacity-80">{issue.category}</span>
                  </div>
                  <h4 className="mt-2 text-sm font-semibold text-foreground">
                    {index + 1}. {issue.title}
                  </h4>
                  <p className="mt-1 break-all font-mono text-xs text-foreground/65">
                    {location(issue.file, issue.line)}
                    {issue.symbol ? ` · ${issue.symbol}` : ""}
                  </p>
                  <dl className="mt-3 grid gap-2 text-sm text-foreground/85">
                    <div><dt className="inline font-medium text-foreground">Description: </dt><dd className="inline">{issue.description}</dd></div>
                    <div><dt className="inline font-medium text-foreground">Evidence: </dt><dd className="inline">{issue.evidence}</dd></div>
                    <div><dt className="inline font-medium text-foreground">Suggestion: </dt><dd className="inline">{issue.suggestion}</dd></div>
                    <div><dt className="inline font-medium text-foreground">Verification: </dt><dd className="inline">{issue.verification}</dd></div>
                  </dl>
                  {!!issue.alternativeFixes?.length && (
                    <div className="mt-3 border-t border-current/15 pt-2">
                      <p className="text-xs font-medium text-foreground">Alternative fixes</p>
                      <List items={issue.alternativeFixes} render={(value) => String(value)} />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
      </Section>

      <Section
        title={`Test Coverage Gaps · ${report.testCoverageGaps.length}`}
        icon={<FileWarning className="size-4 text-orange-400" />}
      >
        <List
          items={report.testCoverageGaps}
          render={(value) => {
            const gap = value as (typeof report.testCoverageGaps)[number];
            return <><code>{gap.file}</code> — {gap.untestedBehavior}</>;
          }}
        />
      </Section>

      <Section title="Verdict">
        <div className="flex items-start gap-3">
          <span className={cn(
            "shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold",
            report.verdict.ready === "yes"
              ? "border-emerald-500/35 bg-emerald-500/8 text-emerald-300"
              : report.verdict.ready === "with-fixes"
                ? "border-amber-500/35 bg-amber-500/8 text-amber-300"
                : "border-red-500/35 bg-red-500/8 text-red-300",
          )}>
            {report.verdict.ready}
          </span>
          <p className="text-sm text-foreground/90">{report.verdict.reasoning}</p>
        </div>
      </Section>

      <Section title="Summary of change">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {report.summaryOfChange}
        </p>
      </Section>

      <Section title="Review summary">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {report.reviewSummary}
        </p>
      </Section>
    </article>
  );
}
