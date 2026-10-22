import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HOST_MAINTENANCE_EVENT,
  isActiveHostUpdateJob,
  type HostMaintenanceSnapshot,
} from "@orkestrator/protocol/host-maintenance";
import type { HostMaintenanceClient } from "@/lib/host-maintenance-client";
import { portalListenAuthoritative } from "@/lib/portal/portal-transport";
import { machineMaintenanceClient } from "./machine-access";
import type { MachineEntry } from "./machine-list";

/** While something runs on a node, how often its snapshot is read again. */
const BUSY_POLL_MS = 2_500;
const IDLE_POLL_MS = 20_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function busy(snapshot: HostMaintenanceSnapshot | null): boolean {
  if (!snapshot) return false;
  return (
    isActiveHostUpdateJob(snapshot.job) ||
    snapshot.checkRequest !== null ||
    Object.values(snapshot.tasks).some((task) => task?.state === "running")
  );
}

/** Terminal task identities, including tasks that finished between polls. */
function taskKey(snapshot: HostMaintenanceSnapshot | null): string {
  return Object.values(snapshot?.tasks ?? {})
    .filter((task) => task && task.state !== "running")
    .map((task) => `${task?.kind}:${task?.id}:${task?.state}`)
    .sort()
    .join("|");
}

/** Keeps the live readings (impact, tools, image) of a detailed read across plain ones. */
export function mergeMaintenanceSnapshot(
  previous: HostMaintenanceSnapshot | null,
  next: HostMaintenanceSnapshot,
): HostMaintenanceSnapshot {
  return {
    ...next,
    ...((next.impact ?? previous?.impact) ? { impact: next.impact ?? previous?.impact } : {}),
    ...((next.tools ?? previous?.tools) ? { tools: next.tools ?? previous?.tools } : {}),
    ...(next.image !== undefined
      ? { image: next.image }
      : previous?.image !== undefined
        ? { image: previous.image }
        : {}),
  };
}

/**
 * One machine's host maintenance snapshot, kept current while mounted.
 *
 * The command node's own snapshot follows its `host-maintenance-updated`
 * events and rehydrates on every reconnect. Another node's events stay on
 * that node, so its snapshot is read through the command node: often while
 * an update or task runs, otherwise now and then. A detailed read happens
 * first and again whenever a dependency task finishes.
 */
export function useMachineMaintenance(
  machine: Pick<MachineEntry, "key" | "role" | "nodeId" | "maintenance"> | null,
  options: { initial?: HostMaintenanceSnapshot | null } = {},
): {
  client: HostMaintenanceClient | null;
  snapshot: HostMaintenanceSnapshot | null;
  error: string | null;
  accept: (snapshot: HostMaintenanceSnapshot) => void;
  reload: () => Promise<void>;
} {
  const role = machine?.role;
  const nodeId = machine?.nodeId ?? null;
  const reachable = machine?.maintenance === true;
  const client = useMemo(
    () => (role && reachable ? machineMaintenanceClient({ role, nodeId }) : null),
    [role, nodeId, reachable],
  );
  const [snapshot, setSnapshot] = useState<HostMaintenanceSnapshot | null>(options.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(options.initial?.revision ?? -1);
  const activeClient = useRef(client);
  useEffect(() => {
    activeClient.current = client;
    return () => {
      activeClient.current = null;
    };
  }, [client]);

  // The dialog showing this is keyed by machine, so the client only changes
  // between null and that machine's client.
  const accept = useCallback((next: HostMaintenanceSnapshot) => {
    if (next.revision < revision.current) return;
    revision.current = next.revision;
    setSnapshot((previous) => mergeMaintenanceSnapshot(previous, next));
    setError(null);
  }, []);

  const read = useCallback(
    async (detail: boolean): Promise<void> => {
      if (!client) return;
      try {
        const next = await client.getHostMaintenance(detail);
        if (activeClient.current === client) accept(next);
      } catch (failure) {
        if (activeClient.current === client) setError(errorText(failure));
      }
    },
    [accept, client],
  );
  const reload = useCallback(() => read(true), [read]);

  // The command node's own events reach this client; another node's do not.
  useEffect(() => {
    if (!client || role !== "self") return;
    const controller = new AbortController();
    void portalListenAuthoritative<HostMaintenanceSnapshot>(
      HOST_MAINTENANCE_EVENT,
      (event) => accept(event.payload),
      { onResync: reload, resyncOnSubscribe: true, signal: controller.signal },
    ).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(errorText(failure));
    });
    return () => controller.abort();
  }, [accept, client, reload, role]);

  const working = busy(snapshot);
  useEffect(() => {
    if (!client || role === "self") return;
    void reload();
  }, [client, reload, role]);
  useEffect(() => {
    if (!client || role === "self") return;
    const timer = setInterval(() => void read(false), working ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [client, read, role, working]);

  // A finished task changed what the live readings report.
  const tasks = taskKey(snapshot);
  const previousTasks = useRef(taskKey(options.initial ?? null));
  useEffect(() => {
    const before = previousTasks.current;
    previousTasks.current = tasks;
    if (tasks && before !== tasks) void reload();
  }, [reload, tasks]);

  return { client, snapshot, error, accept, reload };
}
