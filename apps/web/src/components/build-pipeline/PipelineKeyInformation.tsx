import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  FileText,
  SquareArrowOutUpRight,
  X,
  XCircle,
} from "lucide-react";
import {
  hasKeyInformation,
  type BuildPipelineKeyInformation,
} from "@orkestrator/protocol/build-pipeline-key-information";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  KEY_INFORMATION_ISSUE_STATUS as ISSUE_STATUS,
  KEY_INFORMATION_TEST_RESULT as TEST_RESULT,
  keyInformationUpdatedLine,
} from "./key-information-format";
import {
  useKeepActiveEntryInView,
  useKeyInformationSectionNav,
} from "./key-information-section-nav";
import { KeyInformationProse } from "./KeyInformationProse";
import { KeyInformationText } from "./KeyInformationText";

/**
 * The pipeline header's Key information button and the floating panel it
 * opens: the running brief the Build, Address and Verify stages keep about
 * the ticket (`@orkestrator/protocol/build-pipeline-key-information`).
 *
 * The panel positions itself against the nearest positioned ancestor, the
 * tab header, so it floats over the graph rather than pushing it down.
 *
 * With `onOpenTab` the brief can also be read as a full tab: the panel's
 * pop-out button turns the panel into that tab, and right-clicking the header
 * button opens the tab directly without showing the panel first.
 *
 * Merging lives in the action bar (one Merge PR button and the auto-merge
 * toggle), not here.
 */
export function PipelineKeyInformationButton({
  keyInformation,
  onOpenTab,
}: {
  keyInformation: BuildPipelineKeyInformation | undefined;
  /** Opens (or focuses) the brief's tab; returns whether a tab is now shown. */
  onOpenTab?: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const suppressFocusTooltip = useRef(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Restoring focus must not announce a tooltip. A fresh hover or focus may.
  const closeAndRestoreFocus = useCallback(() => {
    suppressFocusTooltip.current = true;
    setTooltipOpen(false);
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeAndRestoreFocus();
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
  }, [open, closeAndRestoreFocus]);

  // The tab takes over from the panel, so focus follows the tab rather than
  // returning to the header button. A tab that could not open (tab limit,
  // environment stopped) leaves the panel as it was.
  const popOut = () => {
    if (!onOpenTab?.()) return;
    setTooltipOpen(false);
    setOpen(false);
  };

  return (
    <>
      <Tooltip
        open={!open && tooltipOpen}
        onOpenChange={(value) => {
          if (!value || !suppressFocusTooltip.current) setTooltipOpen(value);
        }}
      >
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            type="button"
            size="icon"
            variant={open ? "secondary" : "outline"}
            aria-label="Key information"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onBlur={() => {
              suppressFocusTooltip.current = false;
            }}
            onPointerEnter={() => {
              suppressFocusTooltip.current = false;
            }}
            onClick={() => {
              setTooltipOpen(false);
              setOpen((value) => !value);
            }}
            onContextMenu={
              onOpenTab
                ? (event) => {
                    event.preventDefault();
                    popOut();
                  }
                : undefined
            }
          >
            <FileText className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={5}>
          {onOpenTab ? "Key information · right-click to open in a tab" : "Key information"}
        </TooltipContent>
      </Tooltip>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Key information"
          data-testid="pipeline-key-information"
          className="@container absolute top-full right-3 z-50 mt-1 flex max-h-[min(70vh,44rem)] w-[min(44rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium">Key information</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {keyInformationUpdatedLine(keyInformation)}
              </div>
            </div>
            {onOpenTab ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Open key information in a tab"
                    onClick={popOut}
                  >
                    <SquareArrowOutUpRight className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={5}>
                  Open in a tab
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Close key information"
              onClick={closeAndRestoreFocus}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <KeyInformationBody keyInformation={keyInformation} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The brief's sections in reading order, empty ones left out, beside a list
 * of their headings. The list sits outside the scrolling column, so it stays
 * put while the brief scrolls; choosing a heading scrolls smoothly to its
 * section and the heading of the section being read stays highlighted. A
 * narrow panel lays the list out as a row above the column instead.
 */
export function KeyInformationBody({
  keyInformation: info,
}: {
  keyInformation: BuildPipelineKeyInformation | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const sections = info && hasKeyInformation(info) ? panelSections(info) : [];
  const { activeKey, jumpTo, sectionId } = useKeyInformationSectionNav(
    scrollRef,
    sections.map((section) => section.key),
  );
  useKeepActiveEntryInView(navRef, activeKey);
  if (sections.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Nothing has been recorded yet. The Build stage fills this in as it works, and the Address
          and Verify stages add the review issues and verification results.
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col @lg:flex-row">
      <nav
        ref={navRef}
        aria-label="Key information sections"
        className="shrink-0 overflow-x-auto border-b border-border/60 px-2 py-1.5 @lg:w-40 @lg:overflow-x-visible @lg:overflow-y-auto @lg:border-r @lg:border-b-0 @lg:py-3"
      >
        <ul className="flex gap-0.5 @lg:flex-col">
          {sections.map((section) => {
            const active = section.key === activeKey;
            return (
              <li key={section.key} className="shrink-0">
                <button
                  type="button"
                  aria-current={active ? "location" : undefined}
                  title={section.title}
                  className={cn(
                    "w-full truncate rounded-md px-2 py-1 text-left text-xs whitespace-nowrap transition-colors focus-hairline",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                  onClick={() => jumpTo(section.key)}
                >
                  {section.navTitle ?? section.title}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div
        ref={scrollRef}
        data-testid="pipeline-key-information-scroller"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        <div className="flex flex-col gap-4 text-sm">
          {sections.map((section) => (
            <Section key={section.key} id={sectionId(section.key)} title={section.title}>
              {section.body}
            </Section>
          ))}
        </div>
      </div>
    </div>
  );
}

interface PanelSection {
  key: string;
  title: string;
  /** A shorter label for the heading list, where the full title would truncate. */
  navTitle?: string;
  body: ReactNode;
}

function panelSections(info: BuildPipelineKeyInformation): PanelSection[] {
  const rounds = new Set([
    ...info.issues.map((entry) => entry.round),
    ...info.verifications.map((entry) => entry.round),
  ]);
  const showRounds = rounds.size > 1;
  const sections: PanelSection[] = [];
  if (info.summary) {
    sections.push({
      key: "summary",
      title: "Summary",
      body: <Prose text={info.summary} />,
    });
  }
  if (info.statement) {
    sections.push({
      key: "statement",
      title: info.framing === "objective" ? "Objective" : "Problem",
      body: <Prose text={info.statement} />,
    });
  }
  if (info.context) {
    sections.push({
      key: "context",
      title: "Context",
      body: <Prose text={info.context} />,
    });
  }
  if (info.solution) {
    sections.push({
      key: "solution",
      title: "Solution",
      body: <Prose text={info.solution} />,
    });
  }
  if (info.workDone.length > 0) {
    sections.push({
      key: "workDone",
      title: "What was done",
      body: <BulletList items={info.workDone} />,
    });
  }
  if (info.decisions.length > 0) {
    sections.push({
      key: "decisions",
      title: "Decisions",
      body: (
        <ol className="flex flex-col gap-3">
          {info.decisions.map((decision, index) => (
            <li key={index} className="rounded-md border border-border/60 bg-muted/20 p-2.5">
              <div className="font-medium text-foreground">
                <KeyInformationText text={decision.decision} />
              </div>
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
                          <span className="min-w-0 flex-1 break-words">
                            <KeyInformationText text={option.option} />
                          </span>
                          {chosen ? (
                            <span className="shrink-0 rounded border border-emerald-500/40 px-1 text-[11px] text-emerald-400">
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
                  <KeyInformationText text={decision.chosen} />
                </div>
              ) : null}
              {decision.rationale ? (
                <p className="mt-2 break-words whitespace-pre-wrap text-muted-foreground">
                  <KeyInformationText text={decision.rationale} />
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ),
    });
  }
  if (info.notDone.length > 0) {
    sections.push({
      key: "notDone",
      title: "Not done or needs further work",
      navTitle: "Not done",
      body: <BulletList items={info.notDone} />,
    });
  }
  if (info.tests.length > 0) {
    sections.push({
      key: "tests",
      title: "Tests",
      body: (
        <ul className="flex flex-col gap-1.5">
          {info.tests.map((test, index) => {
            const result = TEST_RESULT[test.result];
            return (
              <li key={index} className="flex items-start gap-2">
                <result.icon
                  className={cn("mt-0.5 size-4 shrink-0", result.className)}
                  aria-label={result.label}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs break-all">{test.name}</div>
                  {test.details ? (
                    <div className="break-words text-muted-foreground">
                      <KeyInformationText text={test.details} />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ),
    });
  }
  if (info.issues.length > 0) {
    sections.push({
      key: "issues",
      title: "Review issues",
      body: (
        <ul className="flex flex-col gap-2">
          {info.issues.map((issue, index) => {
            const status = ISSUE_STATUS[issue.status];
            return (
              <li key={index} className="rounded-md border border-border/60 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 break-words text-foreground">
                    <KeyInformationText text={issue.issue} />
                  </span>
                  {issue.severity ? (
                    <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted-foreground uppercase">
                      {issue.severity}
                    </span>
                  ) : null}
                  <span
                    className={cn("shrink-0 rounded border px-1 text-[11px]", status.className)}
                  >
                    {status.label}
                  </span>
                </div>
                {issue.resolution ? (
                  <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
                    <KeyInformationText text={issue.resolution} />
                  </p>
                ) : null}
                {showRounds ? (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Round {issue.round + 1}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ),
    });
  }
  if (info.verifications.length > 0) {
    sections.push({
      key: "verification",
      title: "Verification",
      body: (
        <ul className="flex flex-col gap-2">
          {info.verifications.map((verification) => (
            <li key={verification.round} className="rounded-md border border-border/60 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                {verification.passed === undefined ? (
                  <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
                ) : verification.passed ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-failure" />
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
                  <KeyInformationText text={verification.summary} />
                </p>
              ) : null}
              {verification.checks.length > 0 ? (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {verification.checks.map((check, index) => (
                    <li key={index} className="flex items-start gap-2">
                      {check.passed ? (
                        <CheckCircle2
                          className="mt-0.5 size-4 shrink-0 text-emerald-500"
                          aria-label="Passed"
                        />
                      ) : (
                        <XCircle
                          className="mt-0.5 size-4 shrink-0 text-failure"
                          aria-label="Failed"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="break-words">
                          <KeyInformationText text={check.check} />
                        </div>
                        {check.details ? (
                          <div className="break-words text-muted-foreground">
                            <KeyInformationText text={check.details} />
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
      ),
    });
  }
  return sections;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={title}>
      <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <KeyInformationProse
      text={text}
      className="text-foreground"
      renderText={(value) => <KeyInformationText text={value} />}
    />
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4">
      {items.map((item, index) => (
        <li key={index} className="break-words">
          <KeyInformationText text={item} />
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
              + <KeyInformationText text={pro} />
            </li>
          ))}
        </ul>
      ) : null}
      {cons.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {cons.map((con, index) => (
            <li key={index} className="break-words text-rose-400/90">
              − <KeyInformationText text={con} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
