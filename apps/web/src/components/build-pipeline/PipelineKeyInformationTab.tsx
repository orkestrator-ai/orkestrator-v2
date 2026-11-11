import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { FileText, Hammer, StickyNote } from "lucide-react";
import {
  hasKeyInformation,
  type BuildPipelineKeyInformation,
} from "@orkestrator/protocol/build-pipeline-key-information";
import { pipelineFollowUps } from "@orkestrator/protocol/build-pipeline-notes";
import { Button } from "@/components/ui/button";
import { hydrateBuildPipeline } from "@/lib/build-pipeline-persistence";
import { cn } from "@/lib/utils";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import { getAllLeaves, paneLayoutStore, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { KeyInformationTabData } from "@/types/paneLayout";
import { keyInformationUpdatedLine } from "./key-information-format";
import {
  useKeepActiveEntryInView,
  useKeyInformationSectionNav,
} from "./key-information-section-nav";
import {
  countOpenIssues,
  countTests,
  DecisionCards,
  IssuesByRound,
  NotDoneList,
  TabProse,
  TabSection,
  TestsTable,
  UpdateHistory,
  VerificationRounds,
  verificationVerdict,
  WorkDoneList,
} from "./key-information-tab-sections";
import { PipelineNeedsALook } from "./PipelineNeedsALook";

interface SectionEntry {
  key: string;
  title: string;
  /** A shorter label for the section list, where the full title would truncate. */
  navTitle?: string;
  meta?: string;
  body: ReactNode;
}

interface SummaryTile {
  key: string;
  label: string;
  value: string;
  detail?: string;
  tone: "neutral" | "good" | "bad" | "warn";
}

const TILE_TONE: Record<SummaryTile["tone"], string> = {
  neutral: "text-foreground",
  good: "text-emerald-400",
  bad: "text-failure",
  warn: "text-amber-300",
};

/**
 * A build pipeline's key information as a tab of its own: the brief the
 * header panel shows, laid out for reading and reviewing on a full pane.
 *
 * The tab keeps only the pipeline id; the brief is read from the pipeline
 * record in the store, so every backend update re-renders it in place. Its
 * notes view is the Notes step on a full pane: the same brief, led by what
 * needs a look.
 */
export function PipelineKeyInformationTab({ data }: { data: KeyInformationTabData }) {
  const pipeline = useBuildPipelineStore((state) => state.pipelines.get(data.pipelineId));
  const scope = useNodeScope();
  const notes = data.view === "notes";
  const subject = notes ? "notes" : "key information";
  const Icon = notes ? StickyNote : FileText;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [hydration, setHydration] = useState<{
    pipelineId: string;
    attempt: number;
    status: "missing" | "error";
  } | null>(null);
  const buildTab = usePaneLayoutStore((state) => {
    const root = state.environments.get(data.environmentId)?.root;
    if (!root) return undefined;
    for (const leaf of getAllLeaves(root)) {
      const tab = leaf.tabs.find(
        (candidate) =>
          candidate.type === "claude-build" &&
          candidate.buildTabData?.pipelineId === data.pipelineId,
      );
      if (tab) return `${leaf.id}\u0000${tab.id}`;
    }
    return undefined;
  });

  // As in the build tab: the store is a cache of a backend-owned record, so a
  // tab restored before the project's pipelines loaded fetches its own.
  useEffect(() => {
    if (pipeline) return;
    let cancelled = false;
    void hydrateBuildPipeline(data.pipelineId, undefined, undefined, scope).then(
      () => {
        if (!cancelled) setHydration({ pipelineId: data.pipelineId, attempt, status: "missing" });
      },
      () => {
        if (!cancelled) setHydration({ pipelineId: data.pipelineId, attempt, status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [data.pipelineId, pipeline, attempt, scope]);

  if (!pipeline) {
    const status =
      hydration?.pipelineId === data.pipelineId && hydration.attempt === attempt
        ? hydration.status
        : "loading";
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <p role={status === "error" ? "alert" : "status"}>
          {status === "error"
            ? `Could not load ${subject}.`
            : status === "missing"
              ? "This pipeline is no longer available."
              : `Loading ${subject}…`}
        </p>
        {status === "error" ? (
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  const openPipeline = () => {
    if (!buildTab) return;
    const [paneId, tabId] = buildTab.split("\u0000") as [string, string];
    const store = scope.store(paneLayoutStore).getState();
    store.setActivePane(paneId, data.environmentId);
    store.setActiveTab(paneId, tabId, data.environmentId);
  };

  return (
    <div
      data-testid="pipeline-key-information-tab"
      className="@container flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/40 bg-zinc-900/40 px-4 py-3 @3xl:px-6">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10">
          <Icon aria-hidden className="size-4 text-amber-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{pipeline.taskTitle}</h1>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {notes ? "Notes" : "Key information"} ·{" "}
            {keyInformationUpdatedLine(pipeline.keyInformation)}
          </div>
        </div>
        {buildTab ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Open pipeline"
            className="shrink-0"
            onClick={openPipeline}
          >
            <Hammer className="size-3.5" />
            <span className="hidden @xl:inline">Open pipeline</span>
          </Button>
        ) : null}
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <KeyInformationDocument
          keyInformation={pipeline.keyInformation}
          scrollRef={scrollRef}
          lead={notes ? <PipelineNeedsALook followUps={pipelineFollowUps(pipeline)} /> : undefined}
        />
      </div>
    </div>
  );
}

/**
 * The whole brief, or a note that nothing is recorded yet. Also read by the
 * Notes step, which places `lead` at the top, ahead of the brief.
 */
export function KeyInformationDocument({
  keyInformation: info,
  scrollRef,
  lead,
  singleColumn = false,
}: {
  keyInformation: BuildPipelineKeyInformation | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  lead?: ReactNode;
  /**
   * One section per row whatever the width (Context and Solution are not
   * paired), with the section list from a narrower width: the ticket view's
   * Notes tab, which is narrower than a pane.
   */
  singleColumn?: boolean;
}) {
  if (!info || !hasKeyInformation(info)) {
    return (
      <>
        {lead ? <div className="mx-auto w-full max-w-7xl px-4 pt-4 @3xl:px-8">{lead}</div> : null}
        <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center">
          <FileText aria-hidden className="size-8 text-muted-foreground/60" />
          <p className="text-sm text-foreground">Nothing has been recorded yet</p>
          <p className="text-xs leading-5 text-muted-foreground">
            The Build stage fills this in as it works, and the Address and Verify stages add the
            review issues and verification results. This tab updates as they write.
          </p>
        </div>
      </>
    );
  }
  return (
    <KeyInformationContents
      info={info}
      scrollRef={scrollRef}
      lead={lead}
      singleColumn={singleColumn}
    />
  );
}

function KeyInformationContents({
  info,
  scrollRef,
  lead,
  singleColumn,
}: {
  info: BuildPipelineKeyInformation;
  scrollRef: RefObject<HTMLDivElement | null>;
  lead?: ReactNode;
  singleColumn: boolean;
}) {
  const navRef = useRef<HTMLUListElement>(null);
  const tests = countTests(info.tests);
  const openIssues = countOpenIssues(info);
  const latestVerification = info.verifications.reduce<
    (typeof info.verifications)[number] | undefined
  >((latest, entry) => (!latest || entry.round > latest.round ? entry : latest), undefined);

  const tiles: SummaryTile[] = [];
  if (info.tests.length > 0) {
    tiles.push({
      key: "tests",
      label: "Tests",
      value: `${tests.passed}/${info.tests.length} passed`,
      detail:
        tests.failed > 0
          ? `${tests.failed} failed`
          : tests["not-run"] + tests.skipped > 0
            ? `${tests["not-run"] + tests.skipped} not run or skipped`
            : undefined,
      tone: tests.failed > 0 ? "bad" : tests.passed === info.tests.length ? "good" : "neutral",
    });
  }
  if (info.issues.length > 0) {
    tiles.push({
      key: "issues",
      label: "Review issues",
      value: openIssues > 0 ? `${openIssues} open` : "All handled",
      detail: `${info.issues.length} reported`,
      tone: openIssues > 0 ? "warn" : "good",
    });
  }
  if (latestVerification) {
    tiles.push({
      key: "verification",
      label: "Verification",
      value: capitalize(verificationVerdict(latestVerification)),
      detail: `Round ${latestVerification.round + 1}`,
      tone:
        latestVerification.passed === undefined
          ? "neutral"
          : latestVerification.passed
            ? "good"
            : "bad",
    });
  }
  if (info.decisions.length > 0) {
    tiles.push({
      key: "decisions",
      label: "Decisions",
      value: String(info.decisions.length),
      tone: "neutral",
    });
  }
  if (info.notDone.length > 0) {
    tiles.push({
      key: "notDone",
      label: "Not done",
      value: String(info.notDone.length),
      detail: "needs further work",
      tone: "warn",
    });
  }

  const sections: SectionEntry[] = [];
  if (info.summary) {
    sections.push({
      key: "summary",
      title: "Summary",
      body: <LeadProse text={info.summary} />,
    });
  }
  if (info.statement) {
    sections.push({
      key: "statement",
      title: info.framing === "objective" ? "Objective" : "Problem",
      // Only the brief's opening section is set apart.
      body: info.summary ? <TabProse text={info.statement} /> : <LeadProse text={info.statement} />,
    });
  }
  if (info.context) {
    sections.push({ key: "context", title: "Context", body: <TabProse text={info.context} /> });
  }
  if (info.solution) {
    sections.push({ key: "solution", title: "Solution", body: <TabProse text={info.solution} /> });
  }
  if (info.workDone.length > 0) {
    sections.push({
      key: "workDone",
      title: "What was done",
      meta: String(info.workDone.length),
      body: <WorkDoneList items={info.workDone} />,
    });
  }
  if (info.decisions.length > 0) {
    sections.push({
      key: "decisions",
      title: "Decisions",
      meta: String(info.decisions.length),
      body: <DecisionCards decisions={info.decisions} />,
    });
  }
  if (info.notDone.length > 0) {
    sections.push({
      key: "notDone",
      title: "Not done or needs further work",
      navTitle: "Not done",
      meta: String(info.notDone.length),
      body: <NotDoneList items={info.notDone} />,
    });
  }
  if (info.tests.length > 0) {
    sections.push({
      key: "tests",
      title: "Tests",
      meta: `${tests.passed} of ${info.tests.length} passed`,
      body: <TestsTable tests={info.tests} />,
    });
  }
  if (info.issues.length > 0) {
    sections.push({
      key: "issues",
      title: "Review issues",
      meta: openIssues > 0 ? `${openIssues} open` : `${info.issues.length} handled`,
      body: <IssuesByRound issues={info.issues} />,
    });
  }
  if (info.verifications.length > 0) {
    sections.push({
      key: "verification",
      title: "Verification",
      meta: latestVerification ? verificationVerdict(latestVerification) : undefined,
      body: <VerificationRounds verifications={info.verifications} />,
    });
  }
  if (info.updates.length > 0) {
    sections.push({
      key: "history",
      title: "Update history",
      meta: String(info.updates.length),
      body: <UpdateHistory updates={info.updates} />,
    });
  }

  const { activeKey, jumpTo, sectionId } = useKeyInformationSectionNav(
    scrollRef,
    sections.map((section) => section.key),
  );
  useKeepActiveEntryInView(navRef, activeKey);

  // Context and Solution read side by side once the pane is wide enough for
  // two comfortable measures; everything else is one section per row.
  const paired = new Set(singleColumn ? [] : ["context", "solution"]);
  const pairedSections = sections.filter((section) => paired.has(section.key));
  const firstPairedIndex = sections.findIndex((section) => paired.has(section.key));

  return (
    <div className="mx-auto flex w-full max-w-7xl gap-10 px-4 py-6 @3xl:px-8">
      <nav
        aria-label="Key information sections"
        className={cn(
          "sticky top-6 hidden w-44 shrink-0 self-start",
          singleColumn ? "@3xl:block" : "@5xl:block",
        )}
      >
        <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          On this page
        </div>
        <ul
          ref={navRef}
          className="flex max-h-[calc(100vh-12rem)] flex-col gap-0.5 overflow-y-auto border-l border-border/60"
        >
          {sections.map((section) => (
            <li key={section.key}>
              <button
                type="button"
                aria-current={section.key === activeKey ? "location" : undefined}
                className={cn(
                  "-ml-px flex w-full items-baseline gap-2 border-l py-1 pl-3 text-left text-xs transition-colors",
                  section.key === activeKey
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
                onClick={() => jumpTo(section.key)}
              >
                <span className="min-w-0 flex-1 truncate">{section.navTitle ?? section.title}</span>
                {section.meta && /^\d+$/.test(section.meta) ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    {section.meta}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        {lead}
        {tiles.length > 0 ? (
          <div
            aria-label="At a glance"
            role="group"
            className="grid grid-cols-2 gap-2 @2xl:grid-cols-3 @5xl:grid-cols-5"
          >
            {tiles.map((tile) => (
              <button
                key={tile.key}
                type="button"
                onClick={() => jumpTo(tile.key)}
                className="flex flex-col items-start rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/25"
              >
                <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
                  {tile.label}
                </span>
                <span className={cn("mt-1 text-base font-medium", TILE_TONE[tile.tone])}>
                  {tile.value}
                </span>
                {tile.detail ? (
                  <span className="text-xs text-muted-foreground">{tile.detail}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        {sections.map((section, index) => {
          if (paired.has(section.key)) {
            if (index !== firstPairedIndex) return null;
            return (
              <div
                key="context-solution"
                className={cn("grid gap-8", pairedSections.length > 1 && "@5xl:grid-cols-2")}
              >
                {pairedSections.map((pairedSection) => (
                  <TabSection
                    key={pairedSection.key}
                    id={sectionId(pairedSection.key)}
                    title={pairedSection.title}
                    meta={pairedSection.meta}
                  >
                    {pairedSection.body}
                  </TabSection>
                ))}
              </div>
            );
          }
          return (
            <Fragment key={section.key}>
              <TabSection id={sectionId(section.key)} title={section.title} meta={section.meta}>
                {section.body}
              </TabSection>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function LeadProse({ text }: { text: string }) {
  return (
    <div className="rounded-lg border-l-2 border-blue-400/60 bg-muted/15 px-4 py-3">
      <TabProse text={text} lead />
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
