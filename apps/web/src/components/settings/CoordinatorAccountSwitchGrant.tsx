/**
 * The standing permission for coordinators to switch the active account of
 * one provider without asking, and the switches it allowed. The switches are
 * a log behind a **View log** button, in a dialog, so a long history does not
 * push the account cards down the page.
 *
 * The permission belongs to the machine shown (each machine holds its own,
 * for the switches its coordinators make on it and on the machines it
 * controls), so it reads and writes that machine. A machine that predates it
 * shows nothing and keeps asking.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeCommandNodeEvents, subscribeNodeEvents } from "@/lib/federation/node-events";
import { listenAuthoritative } from "@/lib/native/authoritative-events";
import type { BackendId } from "@orkestrator/protocol/federation";
import { ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InfoHint } from "@/components/ui/info-hint";
import { getCoordinatorAccountSwitchGrant, setCoordinatorAccountSwitchGrant } from "@/lib/backend";
import type { AccountMachine } from "@/lib/backend/agent-accounts";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import type {
  CoordinatorAccountSwitchGrantState,
  CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";

function outcomeLabel(record: CoordinatorAccountSwitchRecord): string | null {
  switch (record.state) {
    case "executed":
      return null;
    case "failed":
      return "Failed";
    case "outcome-unknown":
      return "Outcome unknown";
    default:
      return "Did not finish";
  }
}

/** "9 Nov 2026, 14:03" in the reader's locale and time zone. */
function formatSwitchTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** One switch: when, on which machine, from → to, and who asked and why. */
export function CoordinatorSwitchRecordRow({ record }: { record: CoordinatorAccountSwitchRecord }) {
  const outcome = outcomeLabel(record);
  return (
    <li
      className="space-y-0.5 border-b border-border/60 py-2 text-xs last:border-b-0"
      aria-label={`Switch on ${record.nodeName}`}
    >
      <p className="text-muted-foreground">
        <time dateTime={record.at} title={record.at}>
          {formatSwitchTime(record.at)}
        </time>{" "}
        ({formatRelativeTime(record.at)})
      </p>
      <p className="text-foreground">
        <span className="font-medium">{record.nodeName}</span>:{" "}
        {record.fromAccountLabel ?? record.fromAccountId ?? "previous account"} →{" "}
        <span className="font-medium">{record.toAccountLabel}</span>
        {outcome ? <span className="ml-1.5 text-destructive">{outcome}</span> : null}
      </p>
      <p className="text-muted-foreground">
        Asked by {record.coordinatorName}
        {record.reason ? `: “${record.reason}”` : ""}
      </p>
      {record.authorizedBy === "self-timer" ? (
        <p className="text-muted-foreground">
          Allowed by a timer you set
          {record.userInstruction ? `: you asked “${record.userInstruction}”` : ""}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The switches as a log: a **View log** button with their count, opening a
 * dialog that lists them newest first. The dialog scrolls, closes on Escape
 * and gives focus back to the button (Radix Dialog).
 */
export function CoordinatorSwitchLog({
  records,
  platformLabel,
}: {
  records: readonly CoordinatorAccountSwitchRecord[];
  platformLabel: string;
}) {
  const newestFirst = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const count = newestFirst.length;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          aria-label={`View switch log, ${count} ${count === 1 ? "entry" : "entries"}`}
        >
          <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
          View log
          <span className="rounded bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {count}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent size="xl" className="max-h-[min(80dvh,40rem)] grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>{platformLabel} account switches</DialogTitle>
          <DialogDescription>
            Switches coordinators made without asking, newest first.
          </DialogDescription>
        </DialogHeader>
        <ul
          className="min-h-0 overflow-y-auto pr-1"
          aria-label={`${platformLabel} account switch log`}
          data-testid="coordinator-switch-log"
        >
          {newestFirst.map((record) => (
            <CoordinatorSwitchRecordRow key={record.requestId} record={record} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function CoordinatorAccountSwitchGrant({
  platform,
  platformLabel,
  machine,
  machineName,
  refreshKey,
}: {
  platform: AgentAccountPlatform;
  platformLabel: string;
  machine: AccountMachine;
  machineName: string | null;
  /** Changes when the accounts view reloads, so a new switch shows here too. */
  refreshKey: string;
}) {
  const [state, setState] = useState<CoordinatorAccountSwitchGrantState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);

  const load = useCallback(() => {
    const request = ++revision.current;
    void getCoordinatorAccountSwitchGrant(platform, machine).then(
      (loaded) => {
        if (revision.current === request) setState(loaded);
      },
      (cause: unknown) => {
        if (revision.current === request)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [platform, machine]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    const events = ["node-action-requests-changed", "coordinator-account-switched"];
    if (machine !== undefined) {
      const subscriber = { events, onEvent: load, onResync: load };
      return machine === null
        ? subscribeCommandNodeEvents(subscriber)
        : subscribeNodeEvents(machine as BackendId, subscriber);
    }
    const controller = new AbortController();
    void listenAuthoritative("node-action-requests-changed", load, {
      onResync: load,
      signal: controller.signal,
      resyncOnSubscribe: true,
    })
      .then((stop) => {
        if (controller.signal.aborted) stop();
        else controller.signal.addEventListener("abort", stop, { once: true });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [load, machine]);

  if (!state) return error ? <p className="mt-4 text-xs text-destructive">{error}</p> : null;
  const granted = state.grants[platform];
  const id = `coordinator-switch-grant-${platform}`;
  const where = machineName ?? "this machine";
  const switches = state.recentSwitches.filter((record) => record.platform === platform);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    const request = ++revision.current;
    try {
      const next = await setCoordinatorAccountSwitchGrant(platform, enabled, machine);
      if (revision.current === request) setState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={granted}
          disabled={busy}
          onCheckedChange={(checked) => void change(checked === true)}
        />
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <label htmlFor={id} className="text-sm font-medium text-foreground">
              Let coordinators switch accounts without asking
            </label>
            <InfoHint label="About coordinator account switching">
              <p>
                {granted
                  ? `Coordinators on ${where} switch the active ${platformLabel} account at once, here and on the machines it controls, instead of waiting for your approval.`
                  : `Coordinators on ${where} ask you before switching the active ${platformLabel} account.`}
              </p>
              <p>
                Only to a signed-in account that is not known to be used up, and at most{" "}
                {state.limit.switches} switches per machine in {state.limit.windowMinutes} minutes;
                past that they ask again. Each switch, with any a timer you allowed made, is in the
                log.
              </p>
            </InfoHint>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {switches.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <p className="text-xs text-muted-foreground">Switched without asking</p>
              <CoordinatorSwitchLog records={switches} platformLabel={platformLabel} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
