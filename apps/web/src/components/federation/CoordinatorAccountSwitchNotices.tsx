import { useEffect } from "react";
import { toast } from "sonner";
import { subscribeCommandNodeEvents, subscribeNodeEvents } from "@/lib/federation/node-events";
import { portalStore } from "@/lib/portal/portal-store";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  COORDINATOR_ACCOUNT_SWITCHED_EVENT,
  type CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";

/** One line naming the machine, both accounts, the coordinator and its reason. */
export function describeCoordinatorAccountSwitch(record: CoordinatorAccountSwitchRecord): string {
  const provider = record.platform === "codex" ? "Codex" : "Claude";
  const from = record.fromAccountLabel ?? record.fromAccountId;
  const action = record.state === "executed" ? "switched" : "tried to switch";
  const check =
    record.state === "outcome-unknown"
      ? " The outcome is unknown. Check the active account on the target machine."
      : "";
  const timer =
    record.authorizedBy === "self-timer"
      ? ` A timer you set allowed it${record.userInstruction ? `: you asked “${record.userInstruction}”.` : "."}`
      : "";
  return `The ${record.coordinatorName} ${action} the active ${provider} account on ${record.nodeName}${from ? ` from “${from}”` : ""} to “${record.toAccountLabel}”${record.reason ? `: “${record.reason}”` : "."}${timer}${check}`;
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
 * the standing permission in Settings, or under a self-timer's permission. A missed notice loses nothing: each
 * switch stays listed under that provider's accounts in Settings.
 */
export function CoordinatorAccountSwitchNotices() {
  useEffect(() => {
    const stops = new Map<BackendId, () => void>();
    const show = (source: string, payload: unknown) => {
      if (!isRecord(payload)) return;
      const settled = payload.state === "executed";
      toast[settled ? "info" : "warning"](
        !settled
          ? "Account switch did not complete"
          : payload.authorizedBy === "self-timer"
            ? "Account switched by your timer"
            : "Account switched without asking",
        {
          id: `coordinator-account-switch:${source}:${payload.requestId}`,
          description: `${describeCoordinatorAccountSwitch(payload)}${settled || !payload.message ? "" : ` ${payload.message}`}`,
          duration: 30_000,
        },
      );
    };
    const commandStop = subscribeCommandNodeEvents({
      events: [COORDINATOR_ACCOUNT_SWITCHED_EVENT],
      onEvent: (_event, payload) => show(portalStore.getState().selfId ?? "command", payload),
      // History in Settings is authoritative; do not replay old toasts on resync.
      onResync: () => {},
    });
    const syncNodes = () => {
      const { nodes, selfId } = portalStore.getState();
      const ids = new Set(nodes.map((node) => node.nodeId).filter((id) => id !== selfId));
      for (const [id, stop] of Array.from(stops)) {
        if (!ids.has(id)) {
          stop();
          stops.delete(id);
        }
      }
      for (const id of ids) {
        if (stops.has(id)) continue;
        stops.set(
          id,
          subscribeNodeEvents(id, {
            events: [COORDINATOR_ACCOUNT_SWITCHED_EVENT],
            onEvent: (_event, payload) => show(id, payload),
            onResync: () => {},
          }),
        );
      }
    };
    const storeStop = portalStore.store.subscribe(syncNodes);
    syncNodes();
    return () => {
      storeStop();
      commandStop();
      for (const stop of stops.values()) stop();
    };
  }, []);
  return null;
}
