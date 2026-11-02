import type { ReactNode } from "react";
import { CheckCircle2, CircleDashed, CircleDot, Minus, Plus, XCircle } from "lucide-react";
import {
  KEY_INFORMATION_TEST_RESULTS,
  type BuildPipelineKeyInformation,
  type KeyInformationDecision,
  type KeyInformationIssue,
  type KeyInformationTest,
  type KeyInformationTestResult,
  type KeyInformationUpdate,
  type KeyInformationVerification,
} from "@orkestrator/protocol/build-pipeline-key-information";
import { cn } from "@/lib/utils";
import {
  KEY_INFORMATION_AUTHOR_LABELS,
  KEY_INFORMATION_ISSUE_STATUS,
  KEY_INFORMATION_SECTION_LABELS,
  KEY_INFORMATION_TEST_RESULT,
} from "./key-information-format";

/**
 * The sections of the full key information tab. They show the same records as
 * the header panel's `KeyInformationBody`, laid out for a wide reading column:
 * larger prose, side-by-side options, a tests table and issues grouped by
 * round.
 */

export function TabSection({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  /** A short count or verdict shown beside the heading. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-4">
      <div className="mb-3 flex items-baseline gap-2 border-b border-border/50 pb-1.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        {meta ? <span className="text-xs text-muted-foreground/80">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function TabProse({ text, lead = false }: { text: string; lead?: boolean }) {
  return (
    <p
      className={cn(
        "max-w-[75ch] break-words whitespace-pre-wrap text-foreground",
        lead ? "text-[15px] leading-7" : "text-sm leading-6 text-foreground/90",
      )}
    >
      {text}
    </p>
  );
}

export function WorkDoneList({ items }: { items: string[] }) {
  return (
    <ul className="flex max-w-[85ch] flex-col gap-2">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2.5 text-sm leading-6">
          <CheckCircle2 aria-hidden className="mt-1 size-4 shrink-0 text-emerald-500/80" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function NotDoneList({ items }: { items: string[] }) {
  return (
    <ul className="flex max-w-[85ch] flex-col gap-2">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2.5 text-sm leading-6">
          <CircleDot aria-hidden className="mt-1 size-4 shrink-0 text-amber-400/80" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function DecisionCards({ decisions }: { decisions: KeyInformationDecision[] }) {
  return (
    <ol className="flex flex-col gap-4">
      {decisions.map((decision, index) => {
        const chosenListed = decision.options.some((option) => option.option === decision.chosen);
        return (
          <li key={index} className="rounded-lg border border-border/60 bg-muted/10 p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 pt-0.5 text-sm font-medium break-words text-foreground">
                {decision.decision}
              </div>
            </div>
            {decision.options.length > 0 ? (
              <ul className="mt-3 grid gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
                {decision.options.map((option, optionIndex) => {
                  const chosen = option.option === decision.chosen;
                  return (
                    <li
                      key={optionIndex}
                      className={cn(
                        "flex flex-col rounded-md border p-3",
                        chosen ? "border-emerald-500/50 bg-emerald-500/5" : "border-border/50",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 text-sm break-words">{option.option}</span>
                        {chosen ? (
                          <span className="shrink-0 rounded border border-emerald-500/40 px-1.5 py-px text-[10px] font-medium text-emerald-400 uppercase">
                            Chosen
                          </span>
                        ) : null}
                      </div>
                      {option.pros.length > 0 || option.cons.length > 0 ? (
                        <ul className="mt-2 flex flex-col gap-1 text-xs leading-5">
                          {option.pros.map((pro, proIndex) => (
                            <li key={`p${proIndex}`} className="flex items-start gap-1.5">
                              <Plus
                                aria-label="Pro"
                                className="mt-0.5 size-3.5 shrink-0 text-emerald-400"
                              />
                              <span className="min-w-0 break-words text-foreground/85">{pro}</span>
                            </li>
                          ))}
                          {option.cons.map((con, conIndex) => (
                            <li key={`c${conIndex}`} className="flex items-start gap-1.5">
                              <Minus
                                aria-label="Con"
                                className="mt-0.5 size-3.5 shrink-0 text-rose-400"
                              />
                              <span className="min-w-0 break-words text-foreground/85">{con}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {!chosenListed ? (
              <div className="mt-3 text-sm">
                <span className="text-muted-foreground">Chosen: </span>
                {decision.chosen}
              </div>
            ) : null}
            {decision.rationale ? (
              <div className="mt-3 rounded-md border-l-2 border-emerald-500/40 bg-muted/20 px-3 py-2">
                <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  Why
                </div>
                <p className="mt-0.5 text-sm leading-6 break-words whitespace-pre-wrap text-foreground/85">
                  {decision.rationale}
                </p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Failures first, so the result a reviewer acts on is at the top; otherwise recorded order. */
const TEST_ORDER: Record<KeyInformationTestResult, number> = {
  failed: 0,
  "not-run": 1,
  skipped: 2,
  passed: 3,
};

export function countTests(tests: KeyInformationTest[]): Record<KeyInformationTestResult, number> {
  const counts = Object.fromEntries(
    KEY_INFORMATION_TEST_RESULTS.map((result) => [result, 0]),
  ) as Record<KeyInformationTestResult, number>;
  for (const test of tests) counts[test.result] += 1;
  return counts;
}

export function TestsTable({ tests }: { tests: KeyInformationTest[] }) {
  const ordered = tests
    .map((test, index) => ({ test, index }))
    .sort((a, b) => TEST_ORDER[a.test.result] - TEST_ORDER[b.test.result] || a.index - b.index);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead className="bg-muted/20 text-left text-[11px] tracking-wide text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="w-28 px-3 py-2 font-medium">
              Result
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Check
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium @3xl:table-cell">
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ test, index }) => {
            const result = KEY_INFORMATION_TEST_RESULT[test.result];
            return (
              <tr key={index} className="border-t border-border/40 align-top">
                <td className="px-3 py-2">
                  <span className={cn("flex items-center gap-1.5 text-xs", result.className)}>
                    <result.icon aria-hidden className="size-3.5 shrink-0" />
                    {result.label}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-xs leading-5 break-all">{test.name}</div>
                  {test.details ? (
                    <div className="mt-1 text-xs leading-5 break-words text-muted-foreground @3xl:hidden">
                      {test.details}
                    </div>
                  ) : null}
                </td>
                <td className="hidden px-3 py-2 text-xs leading-5 break-words text-muted-foreground @3xl:table-cell">
                  {test.details ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function IssuesByRound({ issues }: { issues: KeyInformationIssue[] }) {
  const rounds = [...new Set(issues.map((issue) => issue.round))].sort((a, b) => b - a);
  const showRounds = rounds.length > 1;
  return (
    <div className="flex flex-col gap-5">
      {rounds.map((round) => (
        <div key={round} className="flex flex-col gap-2">
          {showRounds ? (
            <h3 className="text-xs font-medium text-muted-foreground">Round {round + 1}</h3>
          ) : null}
          <ul className="flex flex-col gap-2">
            {issues
              .filter((issue) => issue.round === round)
              .map((issue, index) => {
                const status = KEY_INFORMATION_ISSUE_STATUS[issue.status];
                return (
                  <li key={index} className="rounded-lg border border-border/60 px-4 py-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="min-w-0 flex-1 text-sm leading-6 break-words text-foreground">
                        {issue.issue}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                        {issue.severity ? (
                          <span className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground uppercase">
                            {issue.severity}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            "rounded border px-1.5 py-px text-[10px]",
                            status.className,
                          )}
                        >
                          {status.label}
                        </span>
                      </span>
                    </div>
                    {issue.resolution ? (
                      <p className="mt-2 border-l-2 border-border pl-3 text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                        {issue.resolution}
                      </p>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function verificationVerdict(verification: KeyInformationVerification): string {
  if (verification.passed === undefined) return "in progress";
  return verification.passed ? "passed" : "failed";
}

export function VerificationRounds({
  verifications,
}: {
  verifications: KeyInformationVerification[];
}) {
  // Newest round first: it is the verdict that decides what happens next.
  const ordered = [...verifications].sort((a, b) => b.round - a.round);
  return (
    <ul className="flex flex-col gap-3">
      {ordered.map((verification, index) => (
        <li
          key={verification.round}
          className={cn(
            "rounded-lg border px-4 py-3",
            verification.passed === false
              ? "border-failure/40"
              : verification.passed
                ? "border-emerald-500/40"
                : "border-border/60",
          )}
        >
          <div className="flex items-center gap-2">
            {verification.passed === undefined ? (
              <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
            ) : verification.passed ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
            ) : (
              <XCircle className="size-4 shrink-0 text-failure" />
            )}
            <span className="text-sm font-medium text-foreground">
              Round {verification.round + 1}: {verificationVerdict(verification)}
            </span>
            {index === 0 && ordered.length > 1 ? (
              <span className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground uppercase">
                Latest
              </span>
            ) : null}
          </div>
          {verification.summary ? (
            <p className="mt-2 max-w-[85ch] text-sm leading-6 break-words whitespace-pre-wrap text-foreground/85">
              {verification.summary}
            </p>
          ) : null}
          {verification.checks.length > 0 ? (
            <ul className="mt-3 grid gap-2 @4xl:grid-cols-2">
              {verification.checks.map((check, checkIndex) => (
                <li
                  key={checkIndex}
                  className="flex items-start gap-2 rounded-md bg-muted/15 px-3 py-2"
                >
                  {check.passed ? (
                    <CheckCircle2
                      className="mt-0.5 size-3.5 shrink-0 text-emerald-500"
                      aria-label="Passed"
                    />
                  ) : (
                    <XCircle
                      className="mt-0.5 size-3.5 shrink-0 text-failure"
                      aria-label="Failed"
                    />
                  )}
                  <div className="min-w-0 flex-1 text-sm leading-5">
                    <div className="break-words">{check.check}</div>
                    {check.details ? (
                      <div className="mt-0.5 text-xs leading-5 break-words text-muted-foreground">
                        {check.details}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function UpdateHistory({ updates }: { updates: KeyInformationUpdate[] }) {
  return (
    <ol className="flex flex-col gap-1.5 border-l border-border/60 pl-4">
      {[...updates].reverse().map((update, index) => (
        <li key={index} className="relative text-xs leading-5 text-muted-foreground">
          <span
            aria-hidden
            className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full border border-border bg-background"
          />
          <span className="text-foreground/85">{new Date(update.at).toLocaleString()}</span>
          {" · "}
          {KEY_INFORMATION_AUTHOR_LABELS[update.author]} · round {update.round + 1}
          {update.sections.length > 0
            ? ` · ${update.sections.map((section) => KEY_INFORMATION_SECTION_LABELS[section]).join(", ")}`
            : null}
        </li>
      ))}
    </ol>
  );
}

/** Issues still waiting on work: open or only partly resolved. */
export function countOpenIssues(info: BuildPipelineKeyInformation): number {
  return info.issues.filter(
    (issue) => issue.status === "open" || issue.status === "partially-resolved",
  ).length;
}
