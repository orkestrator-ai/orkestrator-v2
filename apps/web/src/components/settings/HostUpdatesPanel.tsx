import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import {
  CANCELLABLE_HOST_UPDATE_JOB_STATES,
  HOST_UPDATE_CHANNELS,
  isActiveHostUpdateJob,
  isHostUpdateChannel,
  type HostRestartImpact,
  type HostUpdateChannel,
  type HostMaintenanceSnapshot,
  type HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import type { HostMaintenanceClient } from "@/lib/host-maintenance-client";
import { HostDependencySettings, type OutdatedEnvironment } from "./HostDependencySettings";
import { SettingsSectionHeader } from "./SettingsPageLayout";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Seconds until `at`, re-rendered every second while it is in the future. */
function useSecondsUntil(at: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [at]);
  if (!at) return null;
  return Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
}

/** "2 agents working · 1 build pipeline · 3 open terminals", or that nothing is running. */
export function describeRestartImpact(impact: HostRestartImpact): string {
  const parts: string[] = [];
  const plural = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  if (impact.workingAgents) parts.push(`${plural(impact.workingAgents, "agent")} working`);
  if (impact.waitingAgents)
    parts.push(`${plural(impact.waitingAgents, "agent")} waiting for an answer`);
  if (impact.unknownAgents)
    parts.push(`${plural(impact.unknownAgents, "agent")} with unknown activity`);
  if (impact.activePipelines) parts.push(plural(impact.activePipelines, "build pipeline"));
  if (impact.containerTerminals === undefined) {
    // An older backend counts container terminals in with the host's.
    if (impact.terminals) parts.push(plural(impact.terminals, "open terminal"));
  } else {
    const containerTerminals = Math.min(impact.containerTerminals, impact.terminals);
    const hostTerminals = impact.terminals - containerTerminals;
    if (hostTerminals) parts.push(plural(hostTerminals, "host terminal"));
    if (containerTerminals)
      parts.push(
        `${plural(containerTerminals, "container terminal")} (${
          containerTerminals === 1 ? "its shell keeps" : "their shells keep"
        } running)`,
      );
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing is running on the host right now.";
}

/** One line describing an update job, for Settings and the banner. */
export function describeHostUpdateJob(job: HostUpdateJob, secondsLeft: number | null): string {
  const target = job.targetVersion ?? job.requestedVersion ?? "the newest release";
  switch (job.state) {
    case "requested":
      return `Starting the update to ${target}…`;
    case "downloading":
      return `Downloading ${target}${job.progressPercent !== null ? ` (${job.progressPercent}%)` : ""}…`;
    case "waiting-for-idle":
      return `${target} is ready. Waiting until nothing is running on the host${
        job.idleDeadline
          ? ` (at most until ${new Date(job.idleDeadline).toLocaleTimeString()})`
          : ""
      }.`;
    case "awaiting-restart":
      return secondsLeft !== null && secondsLeft > 0
        ? `${target} is ready. The host restarts in ${secondsLeft} s unless someone there postpones it.`
        : `${target} is ready. The host is restarting…`;
    case "restarting":
      return `Restarting the host to install ${target}. This page reconnects when it is back.`;
    case "succeeded":
      return `Updated from ${job.fromVersion} to ${job.targetVersion ?? target}.`;
    case "postponed":
      return `Postponed at the host. ${target} installs the next time Orkestrator quits there.`;
    case "cancelled":
      return "The update was cancelled.";
    case "failed":
      return `The update failed: ${job.error ?? "unknown error"}`;
  }
}

function JobStatus({ job, onCancel }: { job: HostUpdateJob; onCancel: () => void }) {
  const secondsLeft = useSecondsUntil(job.state === "awaiting-restart" ? job.restartAt : null);
  const active = isActiveHostUpdateJob(job);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p
        role="status"
        className={
          job.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {active && (
          <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        )}
        {describeHostUpdateJob(job, secondsLeft)}
      </p>
      {CANCELLABLE_HOST_UPDATE_JOB_STATES.has(job.state) && (
        <Button variant="outline" size="sm" onClick={onCancel}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel update
        </Button>
      )}
    </div>
  );
}

const UPDATE_CHANNELS: Record<HostUpdateChannel, { label: string; description: string }> = {
  stable: { label: "Stable", description: "Tested releases." },
  beta: {
    label: "Beta",
    description: "Previews of the next release, and every stable release.",
  },
  unstable: {
    label: "Unstable",
    description: "Early builds that may break, and every beta and stable release.",
  },
};

const IDLE_WAITS = [
  { seconds: 1_800, label: "30 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 14_400, label: "4 hours" },
  { seconds: 43_200, label: "12 hours" },
] as const;

/**
 * Maintenance of one machine: Orkestrator updates, the pinned toolchain,
 * `gh` and the container image. Works the same from that machine and from
 * any device connected to it, directly or through a command node; the host
 * applies each change.
 */
export function HostUpdatesPanel({
  client,
  snapshot,
  error,
  accept,
  onRebuildEnvironment,
}: {
  client: HostMaintenanceClient;
  snapshot: HostMaintenanceSnapshot | null;
  error: string | null;
  accept: (snapshot: HostMaintenanceSnapshot) => void;
  onRebuildEnvironment?: (environment: OutdatedEnvironment) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [switchingChannel, setSwitchingChannel] = useState(false);
  const [whenIdle, setWhenIdle] = useState(false);
  const [maxWait, setMaxWait] = useState<number>(3_600);
  const [impact, setImpact] = useState<HostRestartImpact | null>(null);

  // Read when the confirmation opens, so it reflects what is running then.
  const openConfirmation = async () => {
    setImpact(null);
    setConfirming(true);
    try {
      setImpact(await client.getHostRestartImpact());
    } catch {
      // The confirmation still works; it just cannot say what is running.
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      accept(await client.requestHostUpdateCheck());
    } catch (failure) {
      toast.error(`Could not check for updates: ${errorText(failure)}`);
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      const result = await client.requestHostUpdate({
        ...(snapshot?.updater.latestVersion ? { version: snapshot.updater.latestVersion } : {}),
        ...(whenIdle ? { drain: "when-idle" as const, maxWaitSeconds: maxWait } : {}),
      });
      accept(result.snapshot);
      setConfirming(false);
    } catch (failure) {
      toast.error(`Could not start the update: ${errorText(failure)}`);
    } finally {
      setInstalling(false);
    }
  };

  const changeChannel = async (channel: HostUpdateChannel) => {
    setSwitchingChannel(true);
    try {
      accept(await client.setHostUpdateChannel(channel));
    } catch (failure) {
      toast.error(`Could not change the update channel: ${errorText(failure)}`);
    } finally {
      setSwitchingChannel(false);
    }
  };

  const cancel = async () => {
    try {
      accept((await client.cancelHostUpdate(snapshot?.job?.id)).snapshot);
    } catch (failure) {
      toast.error(`Could not cancel the update: ${errorText(failure)}`);
    }
  };

  if (!snapshot) {
    return error ? (
      <p className="text-sm text-destructive">{error}</p>
    ) : (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  const { updater, job } = snapshot;
  const jobActive = isActiveHostUpdateJob(job);
  const checkPending = snapshot.checkRequest !== null;
  // Backends before update channels do not report one.
  const channel = isHostUpdateChannel(snapshot.updateChannel) ? snapshot.updateChannel : null;
  const canInstall =
    updater.available &&
    !jobActive &&
    updater.updateAvailable === true &&
    updater.latestVersion !== null;

  return (
    <div className="space-y-10">
      <section className="space-y-6">
        <SettingsSectionHeader title="Orkestrator updates">
          Updates Orkestrator on this machine, from here or any device connected to it.
        </SettingsSectionHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Running</dt>
          <dd className="font-mono">{snapshot.version}</dd>
          {channel && updater.kind !== "none" && (
            <>
              <dt className="self-center text-muted-foreground">Channel</dt>
              <dd>
                <Select
                  value={channel}
                  onValueChange={(value) => void changeChannel(value as HostUpdateChannel)}
                  disabled={switchingChannel || jobActive}
                >
                  <SelectTrigger className="h-8 w-36" aria-label="Update channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                    {HOST_UPDATE_CHANNELS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {UPDATE_CHANNELS[option].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {UPDATE_CHANNELS[channel].description} A more stable channel keeps this version
                  until it has a newer one.
                </span>
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Newest release</dt>
          <dd>
            {updater.checkError ? (
              <span className="text-destructive">Check failed: {updater.checkError}</span>
            ) : updater.latestVersion ? (
              <>
                <span className="font-mono">{updater.latestVersion}</span>
                <span className="text-muted-foreground">
                  {updater.updateAvailable === true
                    ? " · update available"
                    : updater.updateAvailable === false
                      ? " · up to date"
                      : ""}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Not checked yet</span>
            )}
            {updater.checkedAt && (
              <span className="block text-xs text-muted-foreground">
                Checked {new Date(updater.checkedAt).toLocaleString()}
              </span>
            )}
          </dd>
          {updater.kind !== "none" && (
            <>
              <dt className="text-muted-foreground">Updated by</dt>
              <dd>
                {updater.kind === "desktop"
                  ? "The Orkestrator app on the host"
                  : "The backend service itself"}
              </dd>
            </>
          )}
        </dl>

        {!updater.available && updater.reason && (
          <p className="text-sm text-muted-foreground">{updater.reason}</p>
        )}

        {job && <JobStatus job={job} onCancel={() => void cancel()} />}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void check()}
            disabled={!updater.available || checking || checkPending || jobActive}
          >
            {checking || checkPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Check for updates
          </Button>
          <Button size="sm" onClick={() => void openConfirmation()} disabled={!canInstall}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {canInstall ? `Install ${updater.latestVersion}` : "Install update"}
          </Button>
        </div>
      </section>

      <HostDependencySettings
        client={client}
        snapshot={snapshot}
        accept={accept}
        onRebuildEnvironment={onRebuildEnvironment}
      />

      <AlertDialog open={confirming} onOpenChange={(open) => !installing && setConfirming(open)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Install Orkestrator {updater.latestVersion}?</AlertDialogTitle>
            <AlertDialogDescription>
              The host downloads the update, shows a 60-second countdown, then restarts Orkestrator
              to install it. Restarting ends agent turns and terminals running there; containers
              keep running. Someone at the host can postpone the restart.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 text-sm">
            <p data-testid="restart-impact" className="rounded-md border border-border/60 p-3">
              <span className="font-medium">Running now: </span>
              {impact ? describeRestartImpact(impact) : "Checking…"}
            </p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="host-update-when-idle" className="text-sm font-normal">
                Wait until no agent or pipeline is running
              </Label>
              <Switch id="host-update-when-idle" checked={whenIdle} onCheckedChange={setWhenIdle} />
            </div>
            {whenIdle && (
              <div className="flex items-center justify-between gap-4">
                <Label className="text-sm font-normal text-muted-foreground">
                  Restart anyway after
                </Label>
                <Select
                  value={String(maxWait)}
                  onValueChange={(value) => setMaxWait(Number(value))}
                >
                  <SelectTrigger className="w-36" aria-label="Restart anyway after">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                    {IDLE_WAITS.map((option) => (
                      <SelectItem key={option.seconds} value={String(option.seconds)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={installing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void install();
              }}
              disabled={installing}
            >
              {installing && <Loader2 className="h-4 w-4 animate-spin" />}
              {whenIdle ? "Install when idle" : "Install and restart"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
