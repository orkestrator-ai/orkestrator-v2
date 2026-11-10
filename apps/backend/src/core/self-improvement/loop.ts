/**
 * One self-improvement run, free of the backend around it: the service hands
 * it a diagnostics bundle, a board and (optionally) a model runner.
 *
 *   1. Read the board: a tracked signal whose ticket is done becomes `fixed`
 *      (every newer app version carries the fix); a reopened ticket, fixed or
 *      verified, goes back to `tracking`; a deleted ticket becomes `ignored`.
 *      Each ticket is read on its own project's board (the entry records it),
 *      so choosing another project for new tickets leaves older ones alone.
 *   2. Review conversations (when on) and turn themes into signals.
 *   3. Digest the bundle and judge every fix.
 *   4. Act on verdicts: `improved` becomes `verified` with a comment;
 *      `unchanged` or `regressed` moves the ticket back to the backlog.
 *   5. File tickets for new signals above the bar, under daily limits.
 *   6. Save the digest.
 *
 * The ledger is saved after the board is read and after every board change,
 * so a run that fails part-way keeps the record of what it already did: the
 * next run neither files a ticket twice nor bypasses the daily limit. Verdict
 * comments carry a request id that stays the same across runs.
 *
 * A dry run reads and reports but changes nothing: no tickets, no ledger, no
 * saved digest, no model calls.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  SELF_IMPROVEMENT_LIMITS,
  type SelfImprovementRunSummary,
  type SelfImprovementStep,
} from "@orkestrator/protocol/self-improvement";
import type { BundleData } from "./bundle.js";
import { type InsightRun, runInsights } from "./insights/analyze.js";
import type { ModelRunner } from "./insights/model.js";
import { IMPROVEMENT_LABEL, INSIGHT_LABEL, insightTicketFor, LABELS } from "./insights/tickets.js";
import type { TranscriptSources } from "./insights/transcripts.js";
import {
  applyLedgerChange,
  buildDigest,
  type DigestRecord,
  type DigestSignal,
  IMPROVED_RATIO,
  type Judgement,
  type LedgerChange,
  type LedgerEntry,
  listDigests,
  loadLedger,
  saveDigest,
  saveLedger,
} from "./ledger.js";
import { renderDigest } from "./report.js";
import { extractSignals } from "./signals.js";

/** New diagnostics tickets in any 24 hours, however often runs happen. */
export const MAX_NEW_TICKETS = SELF_IMPROVEMENT_LIMITS.diagnosticsTicketsPerDay;
/** New insight tickets in any 24 hours, counted apart from the diagnostics ones. */
export const MAX_NEW_INSIGHT_TICKETS = SELF_IMPROVEMENT_LIMITS.insightTicketsPerDay;
/** The lowest diagnostics score that gets a ticket: an error seen about once a day. */
export const MIN_TICKET_SCORE = 50;
/** An insight theme gets a ticket once it shows up in this many conversations… */
export const MIN_INSIGHT_CONVERSATIONS = 2;
/** …or in one, when it blocked the work (severity 3). */
const BLOCKING_SEVERITY = 3;
const TICKET_WINDOW_MS = 24 * 60 * 60 * 1000;
const TICKET_TITLE_PREFIX = "[improvement]";

export interface BoardTicket {
  id: string;
  title: string;
  status: string;
  prUrl?: string | null;
}

/** One project's board. The service implements it over Kanban storage. */
export interface Board {
  readonly projectId: string;
  /** The ticket, or null when it is not on this project's board. */
  get(ticketId: string): Promise<BoardTicket | null>;
  /** The project any ticket is on, or null when it no longer exists anywhere. */
  locate?(ticketId: string): Promise<string | null>;
  list(): Promise<BoardTicket[]>;
  create(input: {
    title: string;
    description: string;
    criteria: string;
    label: string;
    requestId: string;
  }): Promise<string>;
  /** Posts once per `requestId`: a retry with the same id posts nothing. */
  comment(ticketId: string, text: string, requestId: string): Promise<void>;
  moveToBacklog(ticketId: string): Promise<void>;
  /** Creates each label the project does not have yet. */
  ensureLabels(
    labels: ReadonlyArray<{ name: string; color: string; description: string }>,
  ): Promise<void>;
}

export type LoopSummary = Omit<
  SelfImprovementRunSummary,
  "trigger" | "startedAt" | "finishedAt" | "outcome" | "error"
>;

export interface LoopOptions {
  stateDir: string;
  data: BundleData;
  /** The board new tickets are filed on. */
  board: Board;
  /**
   * Another project's board, for tickets filed while that project was chosen.
   * Without it, those tickets are left as they are until it is chosen again.
   */
  boardFor?: (projectId: string) => Board;
  dryRun?: boolean;
  now?: () => Date;
  onStep?: (step: SelfImprovementStep) => void;
  /** The conversation review: a model runner and where transcripts are. `false` turns it off. */
  insights?: { runner: ModelRunner; sources: TranscriptSources; excludeDirs: string[] } | false;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function formatValue(value: number | null, unit: string): string {
  return value === null ? "–" : `${value} ${unit}`.trim();
}

/** The ticket text for a new diagnostics signal: what the digest saw, and the target a later run checks. */
export function ticketFor(
  signal: DigestSignal,
  digest: DigestRecord,
): { title: string; description: string; criteria: string } {
  const versions = Object.entries(signal.versions)
    .map(([version, slice]) => `${version}: ${slice.value ?? slice.count}`)
    .join(", ");
  const evidence = Object.entries(signal.evidence)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const target = `at most ${Math.round(signal.measure.value * IMPROVED_RATIO * 1000) / 1000} ${signal.measure.unit}`;
  const description = [
    `Found by self-improvement (Settings → Self-improvement) in digest ${digest.id}, from the app's own diagnostics on app ${digest.bundle.appVersion}.`,
    "",
    "## Problem",
    `${signal.title}.`,
    "",
    "## Context",
    `- Signature: \`${signal.signature}\` (${signal.category}, from the ${signal.source}).`,
    `- Measure: ${formatValue(signal.measure.value, signal.measure.unit)} over a ${digest.window.days}-day window; ${signal.count} occurrence(s) on ${signal.activeDays} day(s), last ${signal.lastAt ?? "unknown"}.`,
    versions ? `- By app version: ${versions}.` : null,
    evidence ? `- Evidence: ${evidence}.` : null,
    "- The digest says where and how often, not why: the app's event log holds no messages or stacks. Reproduce it before changing code (docs/development/testing-guide.md, Reproduce before fixing).",
    "",
    "When this ticket is done, the next self-improvement run marks the signal fixed, and later runs check the target below on the newer app versions. They comment here with the result.",
  ]
    .filter((line) => line !== null)
    .join("\n");
  const criteria = `On the release that carries the fix, \`${signal.signature}\` is ${target} over at least a day of use (self-improvement checks this).`;
  return { title: `${TICKET_TITLE_PREFIX} ${signal.title}`.slice(0, 140), description, criteria };
}

function verdictComment(judgement: Judgement, outcome: string): string {
  const watched = judgement.signature.startsWith("insight:")
    ? `${judgement.postFixHours ?? 0} conversation(s)`
    : `${judgement.postFixHours ?? 0} h`;
  return [
    `Self-improvement: ${outcome}.`,
    `\`${judgement.signature}\`: baseline ${formatValue(judgement.baseline, judgement.unit)}, after the fix ${formatValue(judgement.postFixValue, judgement.unit)} over ${watched} on app versions ${judgement.fixedIn ?? "?"}.`,
  ].join("\n");
}

function emptySummary(insightsEnabled: boolean): LoopSummary {
  return {
    digestId: "",
    created: [],
    linked: [],
    verified: [],
    fixFailed: [],
    partly: [],
    markedFixed: [],
    reopenedFromBoard: [],
    ignoredDeleted: [],
    wouldCreate: [],
    heldForTomorrow: 0,
    belowBar: 0,
    conversations: {
      enabled: insightsEnabled,
      read: 0,
      waiting: 0,
      notesAdded: 0,
      themes: 0,
      costUsd: 0,
      heldForTomorrow: 0,
      errors: [],
    },
  };
}

export async function runLoop(options: LoopOptions): Promise<LoopSummary> {
  const { stateDir, data, board } = options;
  const now = options.now ?? (() => new Date());
  const step = options.onStep ?? (() => {});
  const dryRun = options.dryRun === true;
  const summary = emptySummary(Boolean(options.insights));

  // 1. The board.
  step("board");
  const ledger = loadLedger(stateDir);
  const digests = listDigests(stateDir);
  const persist = () => {
    if (!dryRun) saveLedger(stateDir, ledger);
  };
  const boards = new Map<string, Board>([[board.projectId, board]]);
  const boardOf = (projectId: string): Board | null => {
    const known = boards.get(projectId);
    if (known) return known;
    const other = options.boardFor?.(projectId) ?? null;
    if (other) boards.set(projectId, other);
    return other;
  };
  /** The board an entry's ticket is on, or null when that board cannot be reached this run. */
  const ownerOf = (entry: LedgerEntry): Board | null =>
    entry.projectId ? boardOf(entry.projectId) : board;

  let reconciled = false;
  for (const entry of Object.values(ledger.entries)) {
    if (!entry.ticket || entry.status === "ignored") continue;
    if (!entry.projectId) {
      // Saved before the project was recorded: find where the ticket is.
      const located = board.locate ? await board.locate(entry.ticket) : null;
      if (located) {
        entry.projectId = located;
        reconciled = true;
      }
    }
    const owner = ownerOf(entry);
    if (!owner) continue;
    const ticket = await owner.get(entry.ticket);
    const ref = { ticket: entry.ticket, signature: entry.signature };
    if (!ticket) {
      applyLedgerChange(
        ledger,
        entry.signature,
        { status: "ignored", note: "Its ticket was deleted." },
        digests,
        now(),
      );
      summary.ignoredDeleted.push(ref);
      reconciled = true;
      continue;
    }
    if (!entry.projectId) {
      entry.projectId = owner.projectId;
      reconciled = true;
    }
    if (entry.status === "tracking" && ticket.status === "done") {
      applyLedgerChange(
        ledger,
        entry.signature,
        {
          status: "fixed",
          fixedAfter: data.manifest.appVersion,
          ...(ticket.prUrl ? { pr: ticket.prUrl } : {}),
        },
        digests,
        now(),
      );
      summary.markedFixed.push(ref);
      reconciled = true;
    } else if (
      (entry.status === "fixed" || entry.status === "verified") &&
      ticket.status !== "done"
    ) {
      // Someone reopened it: the fix is no longer claimed, whether or not it was verified.
      applyLedgerChange(
        ledger,
        entry.signature,
        { status: "tracking", clearFix: true },
        digests,
        now(),
      );
      summary.reopenedFromBoard.push(ref);
      reconciled = true;
    }
  }
  if (reconciled) persist();

  // 2. Conversations.
  const extracted = extractSignals(data);
  let insightRun: InsightRun | null = null;
  if (options.insights) {
    step("reading-conversations");
    try {
      insightRun = await runInsights({
        stateDir,
        data,
        runner: options.insights.runner,
        sources: options.insights.sources,
        excludeDirs: options.insights.excludeDirs,
        now: now().getTime(),
        dryRun,
        statusOf: (slug) => ledger.entries[`insight:${slug}`]?.status ?? null,
        onThemes: () => step("grouping-themes"),
      });
      extracted.signals.push(...insightRun.signals);
      // Saved notes not yet grouped would make every theme look rarer than it
      // is, so with grouping pending no insight fix is judged this run.
      if (!insightRun.groupingPending) extracted.observedHours.insights = insightRun.readByVersion;
      Object.assign(summary.conversations, {
        read: insightRun.read,
        waiting: insightRun.waiting,
        notesAdded: insightRun.notesAdded,
        themes: insightRun.signals.length,
        costUsd: Math.round(insightRun.costUsd * 100) / 100,
        errors: insightRun.errors,
      });
    } catch (error) {
      summary.conversations.errors.push((error as Error).message);
    }
  }

  // 3. Digest and judge.
  step("digesting");
  const createdAt = Date.parse(data.manifest.createdAt);
  const previous =
    digests.filter((digest) => Date.parse(digest.bundle.createdAt) < createdAt).at(-1) ?? null;
  const digest = buildDigest(data, extracted, previous, ledger, now());
  summary.digestId = digest.id;

  // 4. Verdicts. The ledger changes once the board has been told (step 5).
  const verdicts: Array<{
    signature: string;
    owner: Board;
    ticket: string;
    text: string;
    requestId: string;
    reopen: boolean;
    change: LedgerChange;
  }> = [];
  for (const judgement of digest.judgements) {
    const entry: LedgerEntry | undefined = ledger.entries[judgement.signature];
    if (!entry?.ticket) continue;
    const owner = ownerOf(entry);
    if (!owner) continue;
    const ref = { ticket: entry.ticket, signature: entry.signature };
    // The same verdict on the same fix keeps the same id, so a retried run posts it once.
    const requestId = `self-improvement-verdict-${shortHash(
      [entry.signature, entry.ticket, judgement.verdict, entry.updatedAt].join("\n"),
    )}`;
    if (judgement.verdict === "improved") {
      summary.verified.push(ref);
      verdicts.push({
        signature: entry.signature,
        owner,
        ticket: entry.ticket,
        text: verdictComment(judgement, "the fix is verified"),
        requestId,
        reopen: false,
        change: { status: "verified" },
      });
    } else if (judgement.verdict === "unchanged" || judgement.verdict === "regressed") {
      const outcome =
        judgement.verdict === "regressed"
          ? "the problem has come back"
          : "the fix did not change the rate";
      summary.fixFailed.push({ ...ref, verdict: judgement.verdict });
      verdicts.push({
        signature: entry.signature,
        owner,
        ticket: entry.ticket,
        text: verdictComment(judgement, outcome),
        requestId,
        reopen: true,
        change: {
          status: "tracking",
          clearFix: true,
          note: `${judgement.verdict} in digest ${digest.id}`,
        },
      });
    } else if (judgement.verdict === "partly-improved") {
      summary.partly.push(ref);
    }
  }

  // 5. New tickets: diagnostics and insights each have their own bar and daily limit.
  const untracked = digest.signals.filter((signal) => !ledger.entries[signal.signature]);
  const isInsight = (signal: DigestSignal) => signal.source === "insights";
  const themeOf = (signal: DigestSignal) =>
    insightRun?.themes.themes[signal.signature.slice("insight:".length)];
  const candidates = untracked.filter(
    (signal) => !isInsight(signal) && signal.score >= MIN_TICKET_SCORE,
  );
  const insightCandidates = untracked.filter(
    (signal) =>
      isInsight(signal) &&
      themeOf(signal) !== undefined &&
      (signal.count >= MIN_INSIGHT_CONVERSATIONS || signal.evidence.severity === BLOCKING_SEVERITY),
  );
  summary.belowBar = untracked.filter(
    (signal) => !candidates.includes(signal) && !insightCandidates.includes(signal),
  ).length;
  const filedRecently = (insights: boolean) =>
    Object.values(ledger.entries).filter(
      (entry) =>
        entry.ticket &&
        (entry.source === "insights") === insights &&
        now().getTime() - Date.parse(entry.createdAt) < TICKET_WINDOW_MS,
    ).length;
  const chosenDiagnostics = candidates.slice(
    0,
    Math.max(0, MAX_NEW_TICKETS - filedRecently(false)),
  );
  const chosenInsights = insightCandidates.slice(
    0,
    Math.max(0, MAX_NEW_INSIGHT_TICKETS - filedRecently(true)),
  );
  summary.heldForTomorrow = candidates.length - chosenDiagnostics.length;
  summary.conversations.heldForTomorrow = insightCandidates.length - chosenInsights.length;
  const chosen = [...chosenDiagnostics, ...chosenInsights];
  const textFor = (signal: DigestSignal) => {
    const theme = isInsight(signal) ? themeOf(signal) : undefined;
    return theme ? insightTicketFor(theme, signal, digest) : ticketFor(signal, digest);
  };

  if (dryRun) {
    summary.wouldCreate = chosen.map((signal) => ({
      signature: signal.signature,
      title: textFor(signal).title,
    }));
    return summary;
  }

  step("filing");
  for (const verdict of verdicts) {
    await verdict.owner.comment(verdict.ticket, verdict.text, verdict.requestId);
    if (verdict.reopen) await verdict.owner.moveToBacklog(verdict.ticket);
    applyLedgerChange(ledger, verdict.signature, verdict.change, digests, now());
    persist();
  }

  const openTitles = new Map<string, string>();
  if (chosen.length > 0) {
    for (const ticket of await board.list()) {
      if (ticket.status !== "done") openTitles.set(ticket.title, ticket.id);
    }
    await board.ensureLabels(LABELS);
  }
  const allDigests = [...digests, digest];
  const filedOn = { projectId: board.projectId };
  for (const signal of chosen) {
    const text = textFor(signal);
    const existing = openTitles.get(text.title);
    if (existing) {
      applyLedgerChange(
        ledger,
        signal.signature,
        { ticket: existing, ...filedOn },
        allDigests,
        now(),
      );
      persist();
      summary.linked.push({ ticket: existing, signature: signal.signature });
      continue;
    }
    const ticket = await board.create({
      ...text,
      label: isInsight(signal) ? INSIGHT_LABEL : IMPROVEMENT_LABEL,
      requestId: `self-improvement-${digest.id}-${shortHash(signal.signature)}`,
    });
    // Recorded at once, so a later failure in this run cannot file it again.
    applyLedgerChange(ledger, signal.signature, { ticket, ...filedOn }, allDigests, now());
    persist();
    summary.created.push({ ticket, signature: signal.signature, title: text.title });
  }

  // 6. Save.
  saveDigest(stateDir, digest, renderDigest(digest));
  persist();
  return summary;
}

/** Where the newest saved report is, for people who want the full digest. */
export function reportPath(stateDir: string, digestId: string): string {
  return path.join(stateDir, "digests", `${digestId}.md`);
}
