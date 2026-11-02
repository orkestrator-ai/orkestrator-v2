import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  FileText,
  MinusCircle,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  hasKeyInformation,
  type BuildPipelineKeyInformation,
  type KeyInformationAuthor,
  type KeyInformationIssueStatus,
  type KeyInformationTestResult,
} from "@orkestrator/protocol/build-pipeline-key-information";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const AUTHOR_LABELS: Record<KeyInformationAuthor, string> = {
  build: "Build",
  fix: "Fix",
  review: "Review",
  address: "Address",
  verify: "Verify",
  pr: "Ship",
  "resolve-conflicts": "Conflict resolution",
  system: "the pipeline",
};

const TEST_RESULT: Record<
  KeyInformationTestResult,
  { label: string; icon: LucideIcon; className: string }
> = {
  passed: { label: "Passed", icon: CheckCircle2, className: "text-emerald-500" },
  failed: { label: "Failed", icon: XCircle, className: "text-failure" },
  skipped: { label: "Skipped", icon: MinusCircle, className: "text-muted-foreground" },
  "not-run": { label: "Not run", icon: CircleDashed, className: "text-muted-foreground" },
};

const ISSUE_STATUS: Record<KeyInformationIssueStatus, { label: string; className: string }> = {
  open: { label: "Open", className: "border-amber-500/30 text-amber-300/90" },
  resolved: { label: "Resolved", className: "border-emerald-500/30 text-emerald-400" },
  "partially-resolved": {
    label: "Partially resolved",
    className: "border-amber-500/30 text-amber-300/90",
  },
  deferred: { label: "Deferred", className: "border-border text-muted-foreground" },
  "wont-fix": { label: "Won't fix", className: "border-border text-muted-foreground" },
};

/**
 * The pipeline header's Key information button and the floating panel it
 * opens: the running brief the Build, Address and Verify stages keep about
 * the ticket (`@orkestrator/protocol/build-pipeline-key-information`).
 *
 * The panel positions itself against the nearest positioned ancestor, the
 * tab header, so it floats over the graph rather than pushing it down.
 */
export function PipelineKeyInformationButton({
  keyInformation,
}: {
  keyInformation: BuildPipelineKeyInformation | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            type="button"
            size="icon"
            variant={open ? "secondary" : "outline"}
            aria-label="Key information"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            <FileText className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={5}>
          Key information
        </TooltipContent>
      </Tooltip>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Key information"
          data-testid="pipeline-key-information"
          className="absolute top-full right-3 z-50 mt-1 flex max-h-[min(70vh,44rem)] w-[min(36rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Key information</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {keyInformationUpdatedLine(keyInformation)}
              </div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Close key information"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <KeyInformationBody keyInformation={keyInformation} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function keyInformationUpdatedLine(info: BuildPipelineKeyInformation | undefined): string {
  if (!info || !hasKeyInformation(info)) return "Kept up to date by the pipeline's stages.";
  const last = info.updates.at(-1);
  const at = new Date(info.updatedAt).toLocaleString();
  return last
    ? `Updated ${at} by ${AUTHOR_LABELS[last.author]} · round ${last.round + 1}`
    : `Updated ${at}`;
}

/** The brief's sections in reading order; empty ones are left out. */
export function KeyInformationBody({
  keyInformation: info,
}: {
  keyInformation: BuildPipelineKeyInformation | undefined;
}) {
  if (!info || !hasKeyInformation(info)) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing has been recorded yet. The Build stage fills this in as it works, and the Address
        and Verify stages add the review issues and verification results.
      </p>
    );
  }
  const rounds = new Set([
    ...info.issues.map((entry) => entry.round),
    ...info.verifications.map((entry) => entry.round),
  ]);
  const showRounds = rounds.size > 1;
  return (
    <div className="flex flex-col gap-4 text-xs">
      {info.statement ? (
        <Section title={info.framing === "objective" ? "Objective" : "Problem"}>
          <Prose text={info.statement} />
        </Section>
      ) : null}
      {info.context ? (
        <Section title="Context">
          <Prose text={info.context} />
        </Section>
      ) : null}
      {info.solution ? (
        <Section title="Solution">
          <Prose text={info.solution} />
        </Section>
      ) : null}
      {info.workDone.length > 0 ? (
        <Section title="What was done">
          <BulletList items={info.workDone} />
        </Section>
      ) : null}
      {info.decisions.length > 0 ? (
        <Section title="Decisions">
          <ol className="flex flex-col gap-3">
            {info.decisions.map((decision, index) => (
              <li key={index} className="rounded-md border border-border/60 bg-muted/20 p-2.5">
                <div className="font-medium text-foreground">{decision.decision}</div>
                {decision.options.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-2">
                    {decision.options.map((option, optionIndex) => {
                      const chosen = option.option === decision.chosen;
                      return (
                        <li
                          key={optionIndex}
                          className={cn(
                            "rounded border px-2 py-1.5",
                            chosen ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/40",
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 break-words">{option.option}</span>
                            {chosen ? (
                              <span className="shrink-0 rounded border border-emerald-500/40 px-1 text-[10px] text-emerald-400">
                                Chosen
                              </span>
                            ) : null}
                          </div>
                          <ProsCons pros={option.pros} cons={option.cons} />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {!decision.options.some((option) => option.option === decision.chosen) ? (
                  <div className="mt-2">
                    <span className="text-muted-foreground">Chosen: </span>
                    {decision.chosen}
                  </div>
                ) : null}
                {decision.rationale ? (
                  <p className="mt-2 break-words whitespace-pre-wrap text-muted-foreground">
                    {decision.rationale}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {info.notDone.length > 0 ? (
        <Section title="Not done or needs further work">
          <BulletList items={info.notDone} />
        </Section>
      ) : null}
      {info.tests.length > 0 ? (
        <Section title="Tests">
          <ul className="flex flex-col gap-1.5">
            {info.tests.map((test, index) => {
              const result = TEST_RESULT[test.result];
              return (
                <li key={index} className="flex items-start gap-2">
                  <result.icon
                    className={cn("mt-px size-3.5 shrink-0", result.className)}
                    aria-label={result.label}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] break-all">{test.name}</div>
                    {test.details ? (
                      <div className="break-words text-muted-foreground">{test.details}</div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {info.issues.length > 0 ? (
        <Section title="Review issues">
          <ul className="flex flex-col gap-2">
            {info.issues.map((issue, index) => {
              const status = ISSUE_STATUS[issue.status];
              return (
                <li key={index} className="rounded-md border border-border/60 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 flex-1 break-words text-foreground">
                      {issue.issue}
                    </span>
                    {issue.severity ? (
                      <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground uppercase">
                        {issue.severity}
                      </span>
                    ) : null}
                    <span
                      className={cn("shrink-0 rounded border px-1 text-[10px]", status.className)}
                    >
                      {status.label}
                    </span>
                  </div>
                  {issue.resolution ? (
                    <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
                      {issue.resolution}
                    </p>
                  ) : null}
                  {showRounds ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Round {issue.round + 1}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {info.verifications.length > 0 ? (
        <Section title="Verification">
          <ul className="flex flex-col gap-2">
            {info.verifications.map((verification) => (
              <li
                key={verification.round}
                className="rounded-md border border-border/60 px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5">
                  {verification.passed === undefined ? (
                    <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : verification.passed ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="size-3.5 shrink-0 text-failure" />
                  )}
                  <span className="font-medium text-foreground">
                    Round {verification.round + 1}:{" "}
                    {verification.passed === undefined
                      ? "in progress"
                      : verification.passed
                        ? "passed"
                        : "failed"}
                  </span>
                </div>
                {verification.summary ? (
                  <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
                    {verification.summary}
                  </p>
                ) : null}
                {verification.checks.length > 0 ? (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {verification.checks.map((check, index) => (
                      <li key={index} className="flex items-start gap-2">
                        {check.passed ? (
                          <CheckCircle2
                            className="mt-px size-3.5 shrink-0 text-emerald-500"
                            aria-label="Passed"
                          />
                        ) : (
                          <XCircle
                            className="mt-px size-3.5 shrink-0 text-failure"
                            aria-label="Failed"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="break-words">{check.check}</div>
                          {check.details ? (
                            <div className="break-words text-muted-foreground">{check.details}</div>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Prose({ text }: { text: string }) {
  return <p className="break-words whitespace-pre-wrap text-foreground">{text}</p>;
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4">
      {items.map((item, index) => (
        <li key={index} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

function ProsCons({ pros, cons }: { pros: string[]; cons: string[] }) {
  if (pros.length === 0 && cons.length === 0) return null;
  return (
    <div className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
      {pros.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {pros.map((pro, index) => (
            <li key={index} className="break-words text-emerald-400/90">
              + {pro}
            </li>
          ))}
        </ul>
      ) : null}
      {cons.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {cons.map((con, index) => (
            <li key={index} className="break-words text-rose-400/90">
              − {con}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
