import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { CAPABILITY_MANAGEMENT_CHANGED_EVENT } from "@orkestrator/protocol/capability-resources";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";

import { commandScopeListen } from "@/lib/portal/command-scope";

import { describeError } from "./capability-format";

export type ResourceState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; data: T | null };

/**
 * Loads one read from the command node and re-reads it whenever the backend
 * announces a capability change or the event stream reconnects. Events carry
 * only ids, so a missed one is repaired by the next read; the data shown is
 * always an authoritative snapshot.
 */
export function useCapabilityResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): { state: ResourceState<T>; reload: () => void } {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading", data: null });
  const token = useRef(0);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  const reload = useCallback(() => {
    const current = ++token.current;
    setState((previous) => ({ status: "loading", data: previous.data }));
    loadRef
      .current()
      .then((data) => {
        if (token.current === current) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (token.current === current) {
          setState((previous) => ({
            status: "error",
            message: describeError(error),
            data: previous.data,
          }));
        }
      });
  }, []);
  // `deps` names what the read depends on; the loader itself is read through a ref.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    reload();
  }, [reload, ...deps]);
  /* oxlint-enable react-hooks/exhaustive-deps */
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of [
      CAPABILITY_MANAGEMENT_CHANGED_EVENT,
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    ]) {
      void commandScopeListen(event, () => reload())
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [reload]);
  return { state, reload };
}
