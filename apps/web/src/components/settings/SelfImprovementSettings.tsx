import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, ScanSearch } from "lucide-react";
import type {
  SelfImprovementRunRefusal,
  SelfImprovementSettings as Settings,
  SelfImprovementStatus,
  SelfImprovementStep,
} from "@orkestrator/protocol/self-improvement";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { STEP_TEXT } from "@/lib/self-improvement-progress";
import { isWindowMachine, useAccountMachine } from "./account-machine";
import { formatWhen, LastRunDetails, Themes, TrackedTickets } from "./SelfImprovementLists";
import { RunProgressDialog, RunStages, useNow } from "./SelfImprovementProgress";
import {
  SETTINGS_CARD_CLASS,
  SettingsPageLayout,
  SettingsRow,
  SettingsSectionHeader,
} from "./SettingsPageLayout";

const log = createLogger("web.settings");

/** While a run is in progress the page follows it closely; otherwise it refreshes now and then. */
export const RUNNING_POLL_MS = 3000;
export const IDLE_POLL_MS = 60_000;

const REFUSAL_TEXT: Record<SelfImprovementRunRefusal, string> = {
  disabled: "Self-improvement is off. Turn it on in Settings → Experimental.",
  "no-project": "Choose the project that should receive tickets first.",
  "already-running": "A run is already in progress.",
  "not-writer": "Another Orkestrator is using this data folder; runs happen there.",
};

const MODEL_NAMES: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
};

const modelName = (id: string) => MODEL_NAMES[id] ?? id;

const TRIGGER_TEXT = { manual: "Run", daily: "Daily run", "dry-run": "Preview" } as const;

export interface SelfImprovementSettingsProps {
  /** The commands this page uses; tests pass fakes. */
  api?: Pick<
    typeof backend,
    "getSelfImprovementStatus" | "runSelfImprovement" | "getProjects" | "patchGlobalConfig"
  >;
  /** How often the status is re-read, while running and otherwise; tests shorten it. */
  pollMs?: { running: number; idle: number };
}

const POLL_MS = { running: RUNNING_POLL_MS, idle: IDLE_POLL_MS };

/**
 * Settings → Self-improvement (experimental): which project gets tickets,
 * whether conversations are reviewed, the daily run, Run now and Preview, and
 * what runs have found. The backend owns every run; this page only reads its
 * status, so a run carries on while the page is closed.
 */
export function SelfImprovementSettings({
  api = backend,
  pollMs = POLL_MS,
}: SelfImprovementSettingsProps) {
  const { machine } = useAccountMachine();
  const setConfig = useConfigStore((state) => state.setConfig);
  const [status, setStatus] = useState<SelfImprovementStatus | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** When this window received `status`, so progress ages need not trust the backend's clock. */
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  /** The run whose progress window is open, by its start time: a later run does not reopen it. */
  const [progressFor, setProgressFor] = useState<{
    startedAt: string;
    focus: SelfImprovementStep;
  } | null>(null);
  const windowMachine = isWindowMachine(machine);

  const applyStatus = useCallback((value: SelfImprovementStatus) => {
    setStatus(value);
    setReceivedAt(Date.now());
  }, []);
  const showStatus = useCallback(
    (value: SelfImprovementStatus) => {
      applyStatus(value);
      setError(null);
    },
    [applyStatus],
  );
  const statusFailed = useCallback((caught: unknown) => {
    log.warn("self-improvement.status-failed", { error: formatLogError(caught) });
    setError("Could not read self-improvement's status from this machine.");
  }, []);
  const refresh = useCallback(
    () => api.getSelfImprovementStatus().then(showStatus, statusFailed),
    [api, showStatus, statusFailed],
  );

  useEffect(() => {
    if (!windowMachine) return;
    let closed = false;
    api.getSelfImprovementStatus().then(
      (value) => !closed && showStatus(value),
      (caught: unknown) => !closed && statusFailed(caught),
    );
    api.getProjects().then(
      (list) =>
        !closed && setProjects(list.map((project) => ({ id: project.id, name: project.name }))),
      (caught: unknown) =>
        log.warn("self-improvement.projects-failed", { error: formatLogError(caught) }),
    );
    return () => {
      closed = true;
    };
  }, [api, showStatus, statusFailed, windowMachine]);

  const running = status?.running !== null && status?.running !== undefined;
  const now = useNow(running);
  useEffect(() => {
    if (!windowMachine) return;
    const timer = setInterval(() => void refresh(), running ? pollMs.running : pollMs.idle);
    return () => clearInterval(timer);
  }, [refresh, running, windowMachine, pollMs.running, pollMs.idle]);

  const save = async (change: Partial<Settings>) => {
    if (!status) return;
    const next: Settings = {
      ...(status.settings.projectId ? { projectId: status.settings.projectId } : {}),
      conversationReview: status.settings.conversationReview,
      dailyRun: status.settings.dailyRun,
      ...change,
    };
    setBusy(true);
    try {
      setConfig(await api.patchGlobalConfig({ selfImprovement: next }));
      await refresh();
    } catch (caught) {
      log.warn("self-improvement.save-failed", { error: formatLogError(caught) });
      setError("Could not save the setting. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const start = async (dryRun: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.runSelfImprovement({ dryRun });
      applyStatus(result.status);
      if (!result.started && result.refusal) setNotice(REFUSAL_TEXT[result.refusal]);
    } catch (caught) {
      log.warn("self-improvement.run-failed", { error: formatLogError(caught) });
      setError("Could not start a run on this machine.");
    } finally {
      setBusy(false);
    }
  };

  if (!windowMachine) {
    return (
      <SettingsPageLayout title="Self-improvement">
        <p className="text-sm text-muted-foreground">
          Self-improvement runs on the machine this window runs on. Select it above to use it.
        </p>
      </SettingsPageLayout>
    );
  }

  const settings = status?.settings;
  const progress = status?.running?.progress;
  const progressView =
    status?.running && progress
      ? {
          running: status.running,
          progress,
          models: status.models,
          modelName,
          clock: { now, receivedAt },
        }
      : null;
  const models = status
    ? `${MODEL_NAMES[status.models.notes] ?? status.models.notes} reads each conversation, ${MODEL_NAMES[status.models.themes] ?? status.models.themes} groups the notes into themes`
    : "";

  return (
    <SettingsPageLayout
      width="wide"
      title="Self-improvement"
      description="Finds what to fix or improve from how this machine actually behaves: its own diagnostics (crashes, errors, slow work) and, if you allow it, your conversations with agents. It files what it finds as tickets and checks each fix on later app versions."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || running || !status}
            onClick={() => void start(true)}
            title="See what a run would file, without filing anything or calling a model"
          >
            <ScanSearch className="mr-1.5 h-4 w-4" />
            Preview
          </Button>
          <Button size="sm" disabled={busy || running || !status} onClick={() => void start(false)}>
            {running ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            Run now
          </Button>
        </div>
      }
    >
      <div className="space-y-8">
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        {notice ? <p className="text-sm text-amber-400">{notice}</p> : null}

        <section className="space-y-3" aria-labelledby="self-improvement-run">
          <SettingsSectionHeader title="Runs" headingId="self-improvement-run" />
          <div className={`${SETTINGS_CARD_CLASS} space-y-3 p-4`}>
            {!status ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : status.running ? (
              <>
                <p className="flex items-center gap-2 text-sm text-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {STEP_TEXT[status.running.step]}… ({TRIGGER_TEXT[status.running.trigger]} started{" "}
                  {formatWhen(status.running.startedAt)})
                </p>
                {progressView ? (
                  <RunStages
                    {...progressView}
                    onOpen={(focus) =>
                      setProgressFor({ startedAt: progressView.running.startedAt, focus })
                    }
                  />
                ) : null}
              </>
            ) : status.lastRun ? (
              <>
                <p className="text-sm text-foreground">
                  {TRIGGER_TEXT[status.lastRun.trigger]}{" "}
                  {status.lastRun.outcome === "failed" ? "stopped" : "finished"}{" "}
                  {formatWhen(status.lastRun.finishedAt)}
                </p>
                <LastRunDetails
                  run={status.lastRun}
                  titles={Object.fromEntries(
                    status.tracked.map((item) => [item.signature, item.title]),
                  )}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No runs yet. Choose a project below, then Preview to see what it would file, or Run
                now.
              </p>
            )}
            {status?.nextDailyRunAt && !status.running ? (
              <p className="text-xs text-muted-foreground">
                Next daily run: {formatWhen(status.nextDailyRunAt)}
              </p>
            ) : null}
          </div>
        </section>

        {/* Shown once the saved values are known, so no switch flashes its default first. */}
        {status && settings ? (
          <section className="space-y-3" aria-labelledby="self-improvement-settings">
            <SettingsSectionHeader title="Settings" headingId="self-improvement-settings" />
            <div className={`${SETTINGS_CARD_CLASS} divide-y divide-zinc-800`}>
              <SettingsRow
                label="Project for tickets"
                htmlFor="self-improvement-project"
                description="The board that receives [improvement] and [insight] tickets, labelled improvement and insight."
              >
                <Select
                  value={settings?.projectId ?? ""}
                  onValueChange={(projectId) => void save({ projectId })}
                  disabled={busy || !status}
                >
                  <SelectTrigger
                    id="self-improvement-project"
                    className="w-60"
                    aria-label="Project for tickets"
                  >
                    <SelectValue
                      placeholder={
                        settings?.projectId && !status?.project
                          ? "Project no longer exists"
                          : "Choose a project"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow
                label="Review conversations"
                htmlFor="self-improvement-conversations"
                description={
                  <>
                    Reads your Claude Code and Codex conversations to find friction: instructions
                    you keep repeating, confusion, workarounds, mistakes you had to catch. {models},
                    through Claude Code on the active account, so it uses your plan&apos;s limits;
                    Codex conversations are sent to Anthropic too. Tool output and file contents are
                    never sent, and secrets are redacted.
                  </>
                }
              >
                <Switch
                  id="self-improvement-conversations"
                  checked={settings.conversationReview}
                  disabled={busy || !status}
                  onCheckedChange={(conversationReview) => void save({ conversationReview })}
                  aria-label="Review conversations"
                />
              </SettingsRow>
              <SettingsRow
                label="Run daily"
                htmlFor="self-improvement-daily"
                description={`Runs on its own once a day while the app is running. Each day it files at most ${status?.limits.diagnosticsTicketsPerDay ?? 3} improvement and ${status?.limits.insightTicketsPerDay ?? 2} insight tickets, however often it runs.`}
              >
                <Switch
                  id="self-improvement-daily"
                  checked={settings.dailyRun}
                  disabled={busy || !status}
                  onCheckedChange={(dailyRun) => void save({ dailyRun })}
                  aria-label="Run daily"
                />
              </SettingsRow>
            </div>
          </section>
        ) : null}

        {progressView ? (
          <RunProgressDialog
            {...progressView}
            open={progressFor?.startedAt === progressView.running.startedAt}
            onOpenChange={(open) => !open && setProgressFor(null)}
            focus={progressFor?.focus ?? null}
          />
        ) : null}

        {status ? <TrackedTickets items={status.tracked} /> : null}
        {status ? (
          <Themes themes={status.themes} enabled={status.settings.conversationReview} />
        ) : null}
      </div>
    </SettingsPageLayout>
  );
}
