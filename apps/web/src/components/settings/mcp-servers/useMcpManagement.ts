import { useCallback, useEffect, useRef, useState } from "react";

import {
  MCP_MANAGEMENT_CHANGED_EVENT,
  mcpManagementErrorFromUnknown,
  isUnknownMcpManagementCommandError,
  type McpManagementSnapshot,
  type McpManagementTarget,
} from "@orkestrator/protocol/mcp-management";

import type { BackendId } from "@orkestrator/protocol/federation";
import { isWindowMachine, useAccountMachine } from "@/components/settings/account-machine";
import * as backend from "@/lib/backend";
import { subscribeNodeEvents } from "@/lib/federation/node-events";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen } from "@/lib/native/events";

import { portalListen } from "@/lib/portal/portal-transport";

import { mcpErrorReference } from "./McpErrorNotice";

export type LoadState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: "unsupported" }
  | { status: "error"; message: string; reference?: string; code?: string; data: T | null };

export function describeMcpError(error: unknown): string {
  const detail = mcpManagementErrorFromUnknown(error);
  if (detail) return detail.message;
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * Re-read authoritative state whenever the backend says something changed or
 * the event stream reconnects. Events carry no definitions; a missed one only
 * delays a refresh until the next event, reconnect or remount.
 *
 * Also when the browser comes back online: an event can arrive on a stream
 * that survived the outage while the re-read it triggers fails, and nothing
 * else would ever repeat that read.
 *
 * Another machine's events are relayed by the command node; its resync (once
 * the watch is in place, and after any gap) is the re-read.
 */
function useBackendInvalidation(refresh: () => void, machine: string | null | undefined): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const online = () => refreshRef.current();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  useEffect(() => {
    if (typeof machine === "string" && !isWindowMachine(machine)) {
      return subscribeNodeEvents(machine as BackendId, {
        events: [MCP_MANAGEMENT_CHANGED_EVENT],
        onEvent: () => refreshRef.current(),
        onResync: () => refreshRef.current(),
      });
    }
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of [MCP_MANAGEMENT_CHANGED_EVENT, NATIVE_EVENT_STREAM_CONNECTED_EVENT]) {
      void (machine === null ? portalListen : listen)(event, () => refreshRef.current())
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
  }, [machine]);
}

const LOADING = { status: "loading", data: null } as const;

/**
 * Targets for one context. State is keyed by the context it was loaded for,
 * so the render right after a switch — before the new request even starts —
 * never exposes the previous context's targets.
 */
export function useMcpTargets(environmentId: string | null): {
  state: LoadState<McpManagementTarget[]>;
  reload: () => void;
} {
  const { machine } = useAccountMachine();
  const [keyed, setKeyed] = useState<{
    environmentId: string | null;
    state: LoadState<McpManagementTarget[]>;
  }>({ environmentId, state: LOADING });
  const generation = useRef(0);
  const load = useCallback(() => {
    const request = ++generation.current;
    setKeyed((current) => ({
      environmentId,
      state: {
        status: "loading",
        data: current.environmentId === environmentId ? dataOf(current.state) : null,
      },
    }));
    backend
      .listMcpManagementTargets(environmentId ?? undefined, machine)
      .then((list) => {
        if (request === generation.current)
          setKeyed({ environmentId, state: { status: "ready", data: list.targets } });
      })
      .catch((error: unknown) => {
        if (request !== generation.current) return;
        setKeyed((current) => ({
          environmentId,
          state: isUnknownMcpManagementCommandError(error)
            ? { status: "unsupported" }
            : {
                status: "error",
                message: describeMcpError(error),
                reference: mcpErrorReference(error),
                data: current.environmentId === environmentId ? dataOf(current.state) : null,
              },
        }));
      });
  }, [environmentId, machine]);
  useEffect(load, [load]);
  useBackendInvalidation(load, machine);
  return { state: keyed.environmentId === environmentId ? keyed.state : LOADING, reload: load };
}

function dataOf<T>(state: LoadState<T>): T | null {
  return "data" in state ? state.data : null;
}

/**
 * Snapshot for exactly one target. A response for a target the user has
 * since switched away from is dropped, so it can never populate (or be
 * submitted against) the newly selected target. A failed refresh keeps the
 * last snapshot of the same target, so an open editor and its draft survive
 * a transient read failure; the error is still reported.
 */
export function useMcpSnapshot(targetId: string | null): {
  state: LoadState<McpManagementSnapshot>;
  reload: () => void;
} {
  const { machine } = useAccountMachine();
  const [state, setState] = useState<LoadState<McpManagementSnapshot>>(LOADING);
  const generation = useRef(0);
  const currentTarget = useRef(targetId);
  currentTarget.current = targetId;
  const load = useCallback(() => {
    const request = ++generation.current;
    if (!targetId) {
      setState(LOADING);
      return;
    }
    const sameTarget = (current: LoadState<McpManagementSnapshot>) => {
      const data = dataOf(current);
      return data?.target.targetId === targetId ? data : null;
    };
    setState((current) => ({ status: "loading", data: sameTarget(current) }));
    backend
      .getMcpManagementSnapshot(targetId, machine)
      .then((snapshot) => {
        if (request === generation.current && currentTarget.current === targetId)
          setState({ status: "ready", data: snapshot });
      })
      .catch((error: unknown) => {
        if (request !== generation.current) return;
        if (isUnknownMcpManagementCommandError(error)) setState({ status: "unsupported" });
        else
          setState((current) => ({
            status: "error",
            message: describeMcpError(error),
            code: mcpManagementErrorFromUnknown(error)?.code,
            reference: mcpErrorReference(error),
            data: sameTarget(current),
          }));
      });
  }, [targetId, machine]);
  useEffect(load, [load]);
  useBackendInvalidation(load, machine);
  return { state, reload: load };
}

export function newRequestId(): string {
  return `mcpreq-${crypto.randomUUID()}`;
}
