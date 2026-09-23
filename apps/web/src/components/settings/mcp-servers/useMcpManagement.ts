import { useCallback, useEffect, useRef, useState } from "react";

import {
  MCP_MANAGEMENT_CHANGED_EVENT,
  mcpManagementErrorFromUnknown,
  isUnknownMcpManagementCommandError,
  type McpManagementSnapshot,
  type McpManagementTarget,
} from "@orkestrator/protocol/mcp-management";

import * as backend from "@/lib/backend";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen } from "@/lib/native/events";

export type LoadState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: "unsupported" }
  | { status: "error"; message: string; data: T | null };

export function describeMcpError(error: unknown): string {
  const detail = mcpManagementErrorFromUnknown(error);
  if (detail) return detail.message;
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * Re-read authoritative state whenever the backend says something changed or
 * the event stream reconnects. Events carry no definitions; a missed one only
 * delays a refresh until the next event, reconnect or remount.
 */
function useBackendInvalidation(refresh: () => void): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of [MCP_MANAGEMENT_CHANGED_EVENT, NATIVE_EVENT_STREAM_CONNECTED_EVENT]) {
      void listen(event, () => refreshRef.current())
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
  }, []);
}

export function useMcpTargets(environmentId: string | null): {
  state: LoadState<McpManagementTarget[]>;
  reload: () => void;
} {
  const [state, setState] = useState<LoadState<McpManagementTarget[]>>({
    status: "loading",
    data: null,
  });
  const generation = useRef(0);
  const load = useCallback(() => {
    const request = ++generation.current;
    setState((current) => ({ status: "loading", data: "data" in current ? current.data : null }));
    backend
      .listMcpManagementTargets(environmentId ?? undefined)
      .then((list) => {
        if (request === generation.current) setState({ status: "ready", data: list.targets });
      })
      .catch((error: unknown) => {
        if (request !== generation.current) return;
        if (isUnknownMcpManagementCommandError(error)) setState({ status: "unsupported" });
        else setState({ status: "error", message: describeMcpError(error), data: null });
      });
  }, [environmentId]);
  useEffect(load, [load]);
  return { state, reload: load };
}

/**
 * Snapshot for exactly one target. A response for a target the user has
 * since switched away from is dropped, so it can never populate (or be
 * submitted against) the newly selected target.
 */
export function useMcpSnapshot(targetId: string | null): {
  state: LoadState<McpManagementSnapshot>;
  reload: () => void;
} {
  const [state, setState] = useState<LoadState<McpManagementSnapshot>>({
    status: "loading",
    data: null,
  });
  const generation = useRef(0);
  const currentTarget = useRef(targetId);
  currentTarget.current = targetId;
  const load = useCallback(() => {
    const request = ++generation.current;
    if (!targetId) {
      setState({ status: "loading", data: null });
      return;
    }
    setState((current) => ({
      status: "loading",
      data: "data" in current && current.data?.target.targetId === targetId ? current.data : null,
    }));
    backend
      .getMcpManagementSnapshot(targetId)
      .then((snapshot) => {
        if (request === generation.current && currentTarget.current === targetId)
          setState({ status: "ready", data: snapshot });
      })
      .catch((error: unknown) => {
        if (request !== generation.current) return;
        if (isUnknownMcpManagementCommandError(error)) setState({ status: "unsupported" });
        else setState({ status: "error", message: describeMcpError(error), data: null });
      });
  }, [targetId]);
  useEffect(load, [load]);
  useBackendInvalidation(load);
  return { state, reload: load };
}

export function newRequestId(): string {
  return `mcpreq-${crypto.randomUUID()}`;
}
