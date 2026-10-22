import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
} from "@orkestrator/protocol/host-maintenance";
import { portalListen } from "@/lib/portal/portal-transport";
import { machineMaintenanceClient } from "./machine-access";
import type { MachineEntry } from "./machine-list";
import { mergeMaintenanceSnapshot } from "./useMachineMaintenance";

/** How often the list reads every machine's maintenance again while it is shown. */
const SUMMARY_REFRESH_MS = 5 * 60_000;

export interface MaintenanceSummary {
  snapshot: HostMaintenanceSnapshot | null;
  error: string | null;
}

function keep(
  previous: MaintenanceSummary | undefined,
  next: HostMaintenanceSnapshot,
): MaintenanceSummary {
  const current = previous?.snapshot ?? null;
  if (current && next.revision < current.revision) return previous!;
  return { snapshot: mergeMaintenanceSnapshot(current, next), error: null };
}

/**
 * A detailed maintenance reading of every machine the command node can
 * reach, for the list's update buttons. Read when a machine becomes
 * reachable and every few minutes; the command node's own snapshot also
 * follows its events, and the updates dialog reports what it reads.
 */
export function useMaintenanceSummaries(entries: MachineEntry[]) {
  const [summaries, setSummaries] = useState<Record<string, MaintenanceSummary>>({});
  const reachable = entries.filter((entry) => entry.maintenance);
  const signature = reachable.map((entry) => `${entry.key}|${entry.nodeId}`).join(",");
  const targets = useRef(reachable);
  useEffect(() => {
    targets.current = reachable;
  });

  const record = useCallback((key: string, snapshot: HostMaintenanceSnapshot) => {
    setSummaries((previous) => ({ ...previous, [key]: keep(previous[key], snapshot) }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const readAll = () => {
      for (const entry of targets.current) {
        const client = machineMaintenanceClient(entry);
        if (!client) continue;
        client.getHostMaintenance(true).then(
          (snapshot) => {
            if (!cancelled) record(entry.key, snapshot);
          },
          (error: unknown) => {
            if (cancelled) return;
            setSummaries((previous) => ({
              ...previous,
              [entry.key]: {
                snapshot: previous[entry.key]?.snapshot ?? null,
                error: error instanceof Error ? error.message : String(error),
              },
            }));
          },
        );
      }
    };
    readAll();
    const timer = setInterval(readAll, SUMMARY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [record, signature]);

  // The command node's own events reach this client.
  const selfKey = reachable.find((entry) => entry.role === "self")?.key ?? null;
  useEffect(() => {
    if (!selfKey) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void portalListen<HostMaintenanceSnapshot>(HOST_MAINTENANCE_EVENT, ({ payload }) =>
      record(selfKey, payload),
    ).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [record, selfKey]);

  return { summaries, record };
}
