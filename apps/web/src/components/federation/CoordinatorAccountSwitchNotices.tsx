import { useEffect } from "react";
import { toast } from "sonner";
import { portalListen } from "@/lib/portal/portal-transport";
import {
  COORDINATOR_ACCOUNT_SWITCHED_EVENT,
  type CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";

/** One line naming the machine, both accounts, the coordinator and its reason. */
export function describeCoordinatorAccountSwitch(record: CoordinatorAccountSwitchRecord): string {
  const provider = record.platform === "codex" ? "Codex" : "Claude";
  const from = record.fromAccountLabel ?? record.fromAccountId;
  return `The ${record.coordinatorName} switched the active ${provider} account on ${record.nodeName}${from ? ` from “${from}”` : ""} to “${record.toAccountLabel}”${record.reason ? `: “${record.reason}”` : "."}`;
}

function isRecord(value: unknown): value is CoordinatorAccountSwitchRecord {
  const record = value as Partial<CoordinatorAccountSwitchRecord> | null;
  return (
    !!record &&
    typeof record.requestId === "string" &&
    typeof record.nodeName === "string" &&
    typeof record.toAccountLabel === "string" &&
    typeof record.coordinatorName === "string"
  );
}

/**
 * Tells the user, as it happens, that a coordinator switched an account under
 * the standing permission in Settings. A missed notice loses nothing: each
 * switch stays listed under that provider's accounts in Settings.
 */
export function CoordinatorAccountSwitchNotices() {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let active = true;
    void portalListen<unknown>(COORDINATOR_ACCOUNT_SWITCHED_EVENT, ({ payload }) => {
      if (!isRecord(payload)) return;
      const settled = payload.state === "executed";
      toast[settled ? "info" : "warning"](
        settled ? "Account switched without asking" : "Account switch did not complete",
        {
          id: `coordinator-account-switch:${payload.requestId}`,
          description: `${describeCoordinatorAccountSwitch(payload)}${settled ? "" : ` ${payload.message ?? ""}`}`,
          duration: 30_000,
        },
      );
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  return null;
}
