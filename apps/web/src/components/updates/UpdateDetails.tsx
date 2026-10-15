import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import type { ReleaseRequirementItem } from "@orkestrator/protocol/release-requirements";
import {
  isCancellableUpdatePhase,
  isTerminalUpdatePhase,
  type UpdateOffer,
  type UpdateStatusSnapshot,
} from "@orkestrator/protocol/updates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { compareAppVersions } from "@/lib/app-version";
import { channelLabel, PHASE_LABELS, remoteRequesterLabel } from "./update-text";
import type { UpdateTargetHandle } from "./useUpdateTarget";

export type UpdateDetailsProps = {
  target: UpdateTargetHandle;
  /** `local` is this app; `remote` is a machine this app is connected to. */
  scope: "local" | "remote";
  /** The remote machine's name, shown in the consent copy. */
  machineName?: string;
  /** This client's version, checked against a remote target's client floor. */
  clientVersion?: string;
  /** Desktop builds can install on quit; browsers cannot. */
  canInstallOnQuit?: boolean;
};

function RequirementList({
  items,
  tone,
}: {
  items: ReleaseRequirementItem[];
  tone: "blocking" | "consent" | "info";
}) {
  if (items.length === 0) return null;
  const toneClass =
    tone === "blocking"
      ? "border-red-500/40 bg-red-500/5"
      : tone === "consent"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border/60 bg-muted/20";
  return (
    <ul className="space-y-1.5" data-testid={`update-requirements-${tone}`}>
      {items.map((item) => (
        <li key={item.id} className={`rounded-md border px-3 py-2 text-xs ${toneClass}`}>
          <div className="font-medium text-foreground">{item.title}</div>
          <div className="mt-0.5 text-muted-foreground">{item.detail}</div>
          {item.actionOnHost && tone !== "info" ? (
            <div className="mt-1 text-[11px] font-medium text-amber-300">
              Needs someone at the updated machine after the update.
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function compatibilityBlocker(
  offer: UpdateOffer,
  clientVersion?: string,
): ReleaseRequirementItem | null {
  if (!clientVersion) return null;
  const order = compareAppVersions(clientVersion, offer.compatibility.minClientVersion);
  if (order === null || order >= 0) return null;
  return {
    id: "compatibility:client",
    category: "compatibility",
    change: "changed",
    title: `Update this app first (needs ${offer.compatibility.minClientVersion} or later)`,
    detail: `${offer.version} cannot be driven by this ${clientVersion} app. Update this app, then update the remote.`,
    consent: false,
    actionOnHost: false,
    blocking: true,
  };
}

function OfferReview({
  offer,
  snapshot,
  props,
}: {
  offer: UpdateOffer;
  snapshot: UpdateStatusSnapshot;
  props: UpdateDetailsProps;
}) {
  const { target, scope } = props;
  const [approved, setApproved] = useState(false);
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  const extraBlocker = compatibilityBlocker(offer, props.clientVersion);
  const blockers = [
    ...(extraBlocker ? [extraBlocker] : []),
    ...offer.diff.items.filter((item) => item.blocking),
  ];
  const consent = offer.diff.items.filter((item) => item.consent && !item.blocking);
  const informational = offer.diff.items.filter((item) => !item.consent && !item.blocking);
  const needsApproval = consent.length > 0;
  const blocked = blockers.length > 0 || !snapshot.host.canInstall;
  const ready = !blocked && (!needsApproval || approved) && (!offer.downgrade || confirmDowngrade);
  const start = (restartPolicy: "immediate" | "manual") =>
    void target.run((api) =>
      api.start(
        offer,
        consent.map((item) => item.id),
        restartPolicy,
      ),
    );
  const where = scope === "remote" ? (props.machineName ?? "the remote machine") : "this machine";

  return (
    <div className="space-y-3" data-testid="update-offer">
      <div className="text-sm">
        <span className="font-medium text-foreground">
          {offer.downgrade ? "Install" : "Update to"} {offer.version}
        </span>{" "}
        <span className="text-muted-foreground">
          ({channelLabel(offer.channel)}
          {offer.downgrade ? `, older than the running ${snapshot.currentVersion}` : ""})
        </span>
      </div>
      {offer.diff.baseline === "none" ? (
        <p className="text-xs text-muted-foreground">
          The running version predates release requirements, so everything this version needs is
          listed.
        </p>
      ) : null}
      <RequirementList items={blockers} tone="blocking" />
      {needsApproval ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground">Needs your approval on {where}</div>
          <RequirementList items={consent} tone="consent" />
        </div>
      ) : null}
      {informational.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Also changes ({informational.length})
          </summary>
          <div className="mt-2">
            <RequirementList items={informational} tone="info" />
          </div>
        </details>
      ) : null}
      {!snapshot.host.canInstall ? (
        <p className="text-xs text-amber-300" data-testid="update-unavailable-reason">
          {snapshot.host.unavailableReason}
        </p>
      ) : null}
      {needsApproval && !blocked ? (
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Checkbox
            checked={approved}
            onCheckedChange={(checked) => setApproved(checked === true)}
            aria-label="Approve these changes"
          />
          I approve these changes on {where}
        </label>
      ) : null}
      {offer.downgrade && !blocked ? (
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Checkbox
            checked={confirmDowngrade}
            onCheckedChange={(checked) => setConfirmDowngrade(checked === true)}
            aria-label="Confirm installing an older version"
          />
          Install the older {offer.version} now instead of waiting
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {scope === "local" ? (
          <>
            <Button size="sm" disabled={!ready || target.busy} onClick={() => start("immediate")}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {needsApproval ? "Approve, update and restart" : "Update and restart"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!ready || target.busy}
              onClick={() => start("manual")}
            >
              Download now, restart later
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={!ready || target.busy} onClick={() => start("immediate")}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {needsApproval ? "Approve and update remote" : "Update remote"}
          </Button>
        )}
      </div>
      {scope === "remote" ? (
        <p className="text-[11px] text-muted-foreground">
          The remote restarts as soon as the update is ready, which interrupts agents running there.
        </p>
      ) : null}
    </div>
  );
}

export function UpdateDetails(props: UpdateDetailsProps) {
  const { target } = props;
  const snapshot = target.snapshot;
  if (!snapshot) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {target.error ? (
          <>
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            {target.error.message}
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading update status…
          </>
        )}
      </div>
    );
  }
  const job = snapshot.job;
  const active = job && !isTerminalUpdatePhase(job.phase);
  return (
    <div className="space-y-4 text-sm" data-testid="update-details">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Running <span className="font-mono text-foreground">{snapshot.currentVersion}</span>
        </span>
        <span>Channel: {channelLabel(snapshot.channel)}</span>
        {snapshot.check.checkedAt ? (
          <span>Checked {new Date(snapshot.check.checkedAt).toLocaleString()}</span>
        ) : null}
      </div>

      {snapshot.notices.map((notice) => (
        <div
          key={notice.id}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            notice.kind === "update-succeeded"
              ? "border-emerald-500/40 bg-emerald-500/5"
              : "border-amber-500/40 bg-amber-500/5"
          }`}
          data-testid={`update-notice-${notice.kind}`}
        >
          {notice.kind === "update-succeeded" ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
          ) : (
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-foreground">{notice.message}</div>
            {notice.items.map((item) => (
              <div key={item.id} className="text-muted-foreground">
                {item.title}: {item.detail}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
            onClick={() => void target.run((api) => api.acknowledge(notice.id))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {active && job ? (
        <div className="space-y-2" data-testid="update-job">
          <div className="flex items-center gap-2 text-sm text-foreground">
            {job.phase !== "ready" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {PHASE_LABELS[job.phase]} {job.target.version}
            {job.installWhen === "on-quit" ? " (installs when the app quits)" : ""}
          </div>
          {remoteRequesterLabel(job.requester) ? (
            <div className="text-xs text-muted-foreground" data-testid="update-requester">
              Requested by {remoteRequesterLabel(job.requester)}
            </div>
          ) : null}
          {job.progress ? (
            <div className="space-y-1">
              {job.progress.percent !== null ? <Progress value={job.progress.percent} /> : null}
              {job.progress.message ? (
                <div className="text-xs text-muted-foreground">{job.progress.message}</div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {job.phase === "ready" ? (
              <>
                <Button
                  size="sm"
                  disabled={target.busy}
                  onClick={() => void target.run((api) => api.installNow(job.id))}
                >
                  Restart now
                </Button>
                {props.canInstallOnQuit && job.installWhen !== "on-quit" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={target.busy}
                    onClick={() => void target.run((api) => api.installOnQuit(job.id))}
                  >
                    Install when I quit
                  </Button>
                ) : null}
              </>
            ) : null}
            {isCancellableUpdatePhase(job.phase) && job.installWhen !== "on-quit" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={target.busy}
                onClick={() => void target.run((api) => api.cancel(job.id))}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : snapshot.available ? (
        <OfferReview
          // Approval belongs to one manifest: a changed offer starts unapproved.
          key={`${snapshot.available.version}:${snapshot.available.requirementsSha256}`}
          offer={snapshot.available}
          snapshot={snapshot}
          props={props}
        />
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-foreground" data-testid="update-status-line">
            {snapshot.check.status === "failed"
              ? `Could not check for updates: ${snapshot.check.error?.message ?? "unknown error"}`
              : snapshot.check.resolution === "waiting-for-channel"
                ? `${snapshot.currentVersion} is newer than anything on ${channelLabel(snapshot.channel)}; it will be offered the next ${channelLabel(snapshot.channel).toLowerCase()} release that passes it.`
                : snapshot.check.status === "never"
                  ? "Not checked yet."
                  : "Up to date."}
          </div>
          {snapshot.downgradeOption ? (
            <OfferReview
              key={`${snapshot.downgradeOption.version}:${snapshot.downgradeOption.requirementsSha256}`}
              offer={snapshot.downgradeOption}
              snapshot={snapshot}
              props={props}
            />
          ) : null}
        </div>
      )}

      {target.error ? (
        <div className="flex items-start gap-2 text-xs text-red-300" data-testid="update-error">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {target.error.message}
        </div>
      ) : null}

      {!active ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={target.busy || snapshot.check.status === "checking"}
          onClick={() => void target.run((api) => api.check())}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${snapshot.check.status === "checking" ? "animate-spin" : ""}`}
          />
          Check now
        </Button>
      ) : null}
    </div>
  );
}
