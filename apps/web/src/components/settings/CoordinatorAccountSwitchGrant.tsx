/**
 * The standing permission for coordinators to switch the active account of
 * one provider without asking, and the switches it allowed.
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
import { Checkbox } from "@/components/ui/checkbox";
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

export function CoordinatorSwitchRecordRow({ record }: { record: CoordinatorAccountSwitchRecord }) {
  const outcome = outcomeLabel(record);
  return (
    <li className="space-y-0.5 text-xs" aria-label={`Switch on ${record.nodeName}`}>
      <p className="text-foreground">
        <span className="font-medium">{record.nodeName}</span>:{" "}
        {record.fromAccountLabel ?? record.fromAccountId ?? "previous account"} →{" "}
        <span className="font-medium">{record.toAccountLabel}</span>
        {outcome ? <span className="ml-1.5 text-destructive">{outcome}</span> : null}
      </p>
      <p className="text-muted-foreground">
        {record.coordinatorName}, {formatRelativeTime(record.at)}
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
                past that they ask again. Each switch is listed here, with any a timer you allowed
                made.
              </p>
            </InfoHint>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {switches.length > 0 ? (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-medium text-foreground">Switched without asking</p>
              <ul className="space-y-1.5">
                {switches.map((record) => (
                  <CoordinatorSwitchRecordRow key={record.requestId} record={record} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
