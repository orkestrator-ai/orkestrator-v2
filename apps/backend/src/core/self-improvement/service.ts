/**
 * Self-improvement as a backend service: one run at a time, in the background,
 * started from Settings or once a day while the app runs. A run exports this
 * machine's diagnostics in process, optionally reviews conversations with
 * Claude Code on the active account, and files on the chosen project's board
 * (`loop.ts`). State lives in `<data dir>/self-improvement/`.
 *
 * Experimental: nothing runs while `global.experimentalSelfImprovement` is off,
 * the daily check included. Nothing runs either while another backend holds
 * the data directory's writer lease (`isWriter`): the ledger, notes and cursor
 * are shared files, and the run-at-a-time guard is only this process's. The owner calls {@link SelfImprovementService.stop}
 * at shutdown; it clears the timer and aborts model calls in flight.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  type ResolvedSelfImprovementSettings,
  SELF_IMPROVEMENT_LIMITS,
  SELF_IMPROVEMENT_MODELS,
  type SelfImprovementRunStart,
  type SelfImprovementRunSummary,
  type SelfImprovementRunTrigger,
  type SelfImprovementStatus,
  type SelfImprovementStep,
  type SelfImprovementTrackedItem,
} from "@orkestrator/protocol/self-improvement";
import { type BundleData, readBundleArchive } from "./bundle.js";
import { insightsDir, loadThemes } from "./insights/analyze.js";
import {
  type ClaudeCodeLaunch,
  claudeCodeRunner,
  MODEL_TIMEOUT_MS,
  type ModelRunner,
} from "./insights/model.js";
import { defaultSources, type TranscriptSources } from "./insights/transcripts.js";
import { loadLedger, writeAtomic } from "./ledger.js";
import { type Board, runLoop } from "./loop.js";
import { RunProgress } from "./progress.js";

const log = createLogger("self-improvement");

/** How often the daily run is checked for. */
export const DAILY_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** The first check, a little after start so it does not compete with startup. */
const FIRST_DAILY_CHECK_MS = 5 * 60 * 1000;
export const DAILY_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long a stopping backend waits for a run to settle after aborting it. */
const STOP_WAIT_MS = 5000;
const MAX_TRACKED = 50;
const MAX_THEMES = 30;

/** Fixed, content-free reasons a run stopped, by the step it was on. */
const FAILURE_REASONS: Record<SelfImprovementStep, string> = {
  exporting: "Could not export this machine's diagnostics.",
  board: "Could not read the project's board.",
  "reading-conversations": "The conversation review stopped unexpectedly.",
  "grouping-themes": "Grouping conversation notes into themes stopped unexpectedly.",
  digesting: "Could not digest the diagnostics.",
  filing: "Could not update the project's board.",
};

export interface SelfImprovementDeps {
  dataDir: string;
  config(): Promise<{ enabled: boolean; settings: ResolvedSelfImprovementSettings }>;
  projectName(projectId: string): Promise<string | null>;
  /** A diagnostics bundle archive of this backend, as `buildDiagnosticsBundle` builds it. */
  exportBundle(): Promise<Buffer>;
  board(projectId: string): Board;
  /**
   * Whether this backend holds the data directory's writer lease. A backend
   * that does not never starts a run, daily or manual. Absent means it does.
   */
  isWriter?: () => boolean;
  /** The Claude Code to run the conversation review with, on the active account. */
  claudeLaunch(): Promise<{ executable: string; env: NodeJS.ProcessEnv }>;
  transcriptSources?: () => TranscriptSources;
  /**
   * Builds the model runner from the Claude Code launch; tests replace it so no
   * CLI runs. The service still counts its calls for the run's progress.
   */
  modelRunner?: (launch: ClaudeCodeLaunch) => ModelRunner;
  now?: () => Date;
  /** Replaces the timer (tests). */
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}

interface Running {
  trigger: SelfImprovementRunTrigger;
  startedAt: string;
  step: SelfImprovementStep;
  progress: RunProgress;
  done: Promise<void>;
}

export class SelfImprovementService {
  private running: Running | null = null;
  private timer: { cancel(): void } | null = null;
  private stopped = false;
  private abort = new AbortController();

  constructor(private readonly deps: SelfImprovementDeps) {}

  get stateDir(): string {
    return path.join(this.deps.dataDir, "self-improvement");
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const set =
      this.deps.setTimer ??
      ((callback: () => void, delay: number) => {
        const handle = setTimeout(callback, delay);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = set(() => {
      this.timer = null;
      void this.checkDaily()
        .catch((error: unknown) =>
          // The message can quote a state-file path; the name and code are enough.
          log.warn("daily.check-failed", { error: formatLogError(error, { message: false }) }),
        )
        .finally(() => this.schedule(DAILY_CHECK_INTERVAL_MS));
    }, ms);
  }

  /** Starts the daily check. Runs happen only while the switch and the daily run are on. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule(FIRST_DAILY_CHECK_MS);
  }

  /** Stops the daily check and any run in progress. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    this.abort.abort();
    const done = this.running?.done;
    if (done) {
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
    }
  }

  private lastRunPath(): string {
    return path.join(this.stateDir, "last-run.json");
  }

  private lastRun(): SelfImprovementRunSummary | null {
    try {
      return JSON.parse(readFileSync(this.lastRunPath(), "utf8")) as SelfImprovementRunSummary;
    } catch {
      return null;
    }
  }

  /** When the last run that counts for the daily schedule started (not a dry run). */
  private lastCountedRunAt(): number {
    try {
      const value = JSON.parse(
        readFileSync(path.join(this.stateDir, "last-counted-run.json"), "utf8"),
      ) as {
        startedAt?: string;
      };
      return Date.parse(value.startedAt ?? "");
    } catch {
      return Number.NaN;
    }
  }

  private nextDailyRunAt(
    settings: ResolvedSelfImprovementSettings,
    enabled: boolean,
  ): string | null {
    if (!enabled || !settings.dailyRun || !settings.projectId) return null;
    const lastAt = this.lastCountedRunAt();
    const due = Number.isFinite(lastAt) ? lastAt + DAILY_RUN_INTERVAL_MS : this.now().getTime();
    return new Date(Math.max(due, this.now().getTime())).toISOString();
  }

  private isWriter(): boolean {
    return this.deps.isWriter?.() ?? true;
  }

  async checkDaily(): Promise<void> {
    if (this.stopped || this.running || !this.isWriter()) return;
    const { enabled, settings } = await this.deps.config();
    const next = this.nextDailyRunAt(settings, enabled);
    if (next && Date.parse(next) <= this.now().getTime()) {
      await this.run({ trigger: "daily" });
    }
  }

  async status(): Promise<SelfImprovementStatus> {
    const { enabled, settings } = await this.deps.config();
    const name = settings.projectId ? await this.deps.projectName(settings.projectId) : null;
    const ledger = loadLedger(this.stateDir);
    const tracked: SelfImprovementTrackedItem[] = Object.values(ledger.entries)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, MAX_TRACKED)
      .map((entry) => ({
        signature: entry.signature,
        title: entry.title,
        kind: entry.source === "insights" ? "insight" : "diagnostics",
        status: entry.status,
        ticket: entry.ticket ?? null,
        verdict: entry.observations.at(-1)?.verdict ?? null,
        baseline: entry.baseline?.value ?? null,
        unit: entry.baseline?.unit ?? "",
        updatedAt: entry.updatedAt,
      }));
    const themes = Object.values(loadThemes(insightsDir(this.stateDir)).themes)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_THEMES)
      .map((theme) => ({
        slug: theme.slug,
        title: theme.title,
        kind: theme.kind,
        fixWhere: theme.fixWhere,
        summary: theme.summary,
        conversations: Object.keys(theme.conversations).length,
        severity: theme.severity,
        updatedAt: new Date(theme.updatedAt).toISOString(),
      }));
    return {
      enabled,
      settings,
      project: settings.projectId && name ? { id: settings.projectId, name } : null,
      running: this.running
        ? {
            trigger: this.running.trigger,
            startedAt: this.running.startedAt,
            step: this.running.step,
            progress: this.running.progress.snapshot(),
          }
        : null,
      lastRun: this.lastRun(),
      nextDailyRunAt: this.nextDailyRunAt(settings, enabled),
      tracked,
      themes,
      models: SELF_IMPROVEMENT_MODELS,
      limits: SELF_IMPROVEMENT_LIMITS,
    };
  }

  /** Starts a run in the background and answers at once. */
  async run(options: { trigger: SelfImprovementRunTrigger }): Promise<SelfImprovementRunStart> {
    const { enabled, settings } = await this.deps.config();
    const refuse = async (refusal: SelfImprovementRunStart["refusal"]) => ({
      started: false,
      refusal,
      status: await this.status(),
    });
    if (!enabled || this.stopped) return refuse("disabled");
    if (!settings.projectId || !(await this.deps.projectName(settings.projectId)))
      return refuse("no-project");
    if (this.running) return refuse("already-running");
    if (!this.isWriter()) return refuse("not-writer");

    const startedAt = this.now().toISOString();
    const running: Running = {
      trigger: options.trigger,
      startedAt,
      step: "exporting",
      progress: new RunProgress(
        {
          conversations: settings.conversationReview,
          dryRun: options.trigger === "dry-run",
          modelTimeoutMs: MODEL_TIMEOUT_MS,
        },
        () => this.now(),
      ),
      done: Promise.resolve(),
    };
    this.running = running;
    log.info("run.started", { trigger: options.trigger });
    running.done = this.execute(running, settings, settings.projectId)
      .catch((error: unknown) => {
        // `execute` records its own failures; this is the last guard against a fatal rejection.
        log.error("run.failed", {
          reason: "unexpected",
          error: formatLogError(error, { message: false }),
        });
      })
      .finally(() => {
        if (this.running === running) this.running = null;
      });
    return { started: true, status: await this.status() };
  }

  private async execute(
    running: Running,
    settings: ResolvedSelfImprovementSettings,
    projectId: string,
  ): Promise<void> {
    const dryRun = running.trigger === "dry-run";
    const onStep = (step: SelfImprovementStep) => {
      running.step = step;
      running.progress.begin(step);
    };
    let summary: SelfImprovementRunSummary;
    try {
      const data: BundleData = await readBundleArchive(await this.deps.exportBundle());
      let insights: Parameters<typeof runLoop>[0]["insights"] = false;
      if (settings.conversationReview) {
        const launch = await this.deps.claudeLaunch();
        insights = {
          runner: running.progress.track(
            (this.deps.modelRunner ?? claudeCodeRunner)({
              cwd: this.ensureStateDir(),
              ...launch,
              signal: this.abort.signal,
            }),
          ),
          sources: this.deps.transcriptSources?.() ?? defaultSources(this.deps.dataDir),
          excludeDirs: [path.resolve(this.stateDir), path.resolve(this.deps.dataDir)],
        };
      }
      const result = await runLoop({
        stateDir: this.ensureStateDir(),
        data,
        board: this.deps.board(projectId),
        boardFor: (other) => this.deps.board(other),
        dryRun,
        now: () => this.now(),
        onStep,
        insightProgress: running.progress,
        insights,
      });
      summary = {
        ...result,
        trigger: running.trigger,
        startedAt: running.startedAt,
        finishedAt: this.now().toISOString(),
        outcome: "succeeded",
      };
      log.info("run.finished", {
        created: result.created.length,
        verified: result.verified.length,
        fixFailed: result.fixFailed.length,
        parts: result.conversations.read,
      });
    } catch (error) {
      // Content-free: a message can quote a path, a ticket id or provider text.
      log.warn("run.failed", {
        reason: running.step,
        error: formatLogError(error, { message: false }),
      });
      summary = {
        ...emptyFailure(running.trigger, running.startedAt, this.now().toISOString()),
        error: FAILURE_REASONS[running.step],
      };
    }
    writeAtomic(this.lastRunPath(), `${JSON.stringify(summary, null, 2)}\n`);
    // A dry run is shown as the last run, but the daily schedule counts only real ones.
    if (!dryRun) {
      writeAtomic(
        path.join(this.stateDir, "last-counted-run.json"),
        `${JSON.stringify({ startedAt: running.startedAt })}\n`,
      );
    }
  }

  /** The state directory, created owner-only; Claude Code runs in it. */
  private ensureStateDir(): string {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    return this.stateDir;
  }
}

function emptyFailure(
  trigger: SelfImprovementRunTrigger,
  startedAt: string,
  finishedAt: string,
): SelfImprovementRunSummary {
  return {
    digestId: "",
    trigger,
    startedAt,
    finishedAt,
    outcome: "failed",
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
      enabled: false,
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
