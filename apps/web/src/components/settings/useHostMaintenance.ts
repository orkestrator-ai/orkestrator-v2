import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
} from "@orkestrator/protocol/host-maintenance";
import { subscribeToConnections } from "@/lib/connections";
import * as backend from "@/lib/backend";
import { listenAuthoritative } from "@/lib/native/authoritative-events";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "kind:id:state" of every task, to notice one finishing. */
function taskKey(snapshot: HostMaintenanceSnapshot | null): string {
  return Object.values(snapshot?.tasks ?? {})
    .map((task) => `${task?.kind}:${task?.id}:${task?.state}`)
    .sort()
    .join("|");
}

/**
 * The connected backend's host maintenance snapshot, kept current.
 *
 * Rehydrates on mount and on every stream reconnect, applies
 * `host-maintenance-updated` events, and never lets an older revision replace
 * a newer one. With `detail`, live readings (restart impact, tools, image)
 * are read too and kept across events, which carry none; they are read again
 * whenever a dependency task finishes.
 */
export function useHostMaintenance(options: { detail?: boolean } = {}) {
  const detail = options.detail === true;
  const [snapshot, setSnapshot] = useState<HostMaintenanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(-1);
  const [scope, setScope] = useState<{ id: string } | null>(null);
  const connection = useRef<{ id: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    let observed = false;
    const change = (id: string) => {
      if (disposed || connection.current?.id === id) return;
      const next = { id };
      connection.current = next;
      revision.current = -1;
      setSnapshot(null);
      setError(null);
      setScope(next);
    };
    const unlisten = subscribeToConnections((list) => {
      observed = true;
      change(list.activeConnectionId);
    });
    void window.orkestrator?.connections
      ?.list()
      .then((list) => {
        if (!observed) change(list.activeConnectionId);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  const accept = useCallback(
    (next: HostMaintenanceSnapshot) => {
      if (connection.current !== scope) return;
      if (next.revision < revision.current) return;
      revision.current = next.revision;
      setSnapshot((previous) => ({
        ...next,
        ...((next.impact ?? previous?.impact) ? { impact: next.impact ?? previous?.impact } : {}),
        ...((next.tools ?? previous?.tools) ? { tools: next.tools ?? previous?.tools } : {}),
        ...(next.image !== undefined
          ? { image: next.image }
          : previous?.image !== undefined
            ? { image: previous.image }
            : {}),
      }));
      setError(null);
    },
    [scope],
  );

  const reload = useCallback(async () => {
    try {
      accept(await backend.getHostMaintenance(detail));
    } catch (failure) {
      if (connection.current === scope) setError(errorText(failure));
    }
  }, [accept, scope, detail]);

  useEffect(() => {
    const controller = new AbortController();
    void listenAuthoritative<HostMaintenanceSnapshot>(
      HOST_MAINTENANCE_EVENT,
      (event) => accept(event.payload),
      { onResync: reload, resyncOnSubscribe: true, signal: controller.signal },
    ).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(errorText(failure));
    });
    return () => controller.abort();
  }, [accept, reload]);

  // A finished task changed what the live readings report.
  const tasks = taskKey(snapshot);
  const previousTasks = useRef(tasks);
  useEffect(() => {
    const before = previousTasks.current;
    previousTasks.current = tasks;
    if (detail && before && before !== tasks && before.includes(":running")) void reload();
  }, [detail, reload, tasks]);

  return { snapshot, error, accept, reload };
}
