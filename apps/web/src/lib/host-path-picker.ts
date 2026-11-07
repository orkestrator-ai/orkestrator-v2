import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeClient } from "@orkestrator/protocol/node-client";
import { useCallback } from "react";
import { create } from "zustand";
import { projects as projectsDomain } from "@/lib/node-scope/domains/projects";
import type { HostDirectoryListing } from "@/lib/backend/files-sessions";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

export interface HostPathPickerOptions {
  /**
   * The node whose host is browsed: the requesting scope's node
   * (`useScopesWithCommandFallback().scope.nodeId` in a component).
   */
  nodeId: BackendId;
  /** Choose a folder or a file. */
  mode: "directory" | "file";
  title?: string;
  /** Where to start browsing; a stale path falls back to its nearest existing ancestor. */
  defaultPath?: string;
}

export interface HostPathPickerRequest extends HostPathPickerOptions {
  resolve: (path: string | null) => void;
}

interface HostPathPickerState {
  request: HostPathPickerRequest | null;
  /** Settles the open request with the chosen path, or null when cancelled. */
  settle: (path: string | null) => void;
}

export const useHostPathPickerStore = create<HostPathPickerState>()((set, get) => ({
  request: null,
  settle: (path) => {
    const { request } = get();
    if (!request) return;
    set({ request: null });
    request.resolve(path);
  },
}));

/**
 * Opens Orkestrator's own file/folder picker and resolves with the chosen
 * absolute path on `options.nodeId`'s host, or null if the user cancelled.
 *
 * Unlike the operating system's dialog this browses the machine the node's
 * backend runs on, through that node's client, so it behaves the same for the
 * local backend and for a remote one. A picker that is already open is
 * cancelled by a newer request.
 */
export function pickHostPath(options: HostPathPickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useHostPathPickerStore.getState().settle(null);
    useHostPathPickerStore.setState({ request: { ...options, resolve } });
  });
}

/** `pickHostPath` on the node of the scope the calling component renders in. */
export function usePickHostPath(): (
  options: Omit<HostPathPickerOptions, "nodeId">,
) => Promise<string | null> {
  const nodeId = useScopesWithCommandFallback().scope.nodeId;
  return useCallback((options) => pickHostPath({ ...options, nodeId }), [nodeId]);
}

/** Lists a directory on `client`'s host (`list_host_directory`); omit `path` for home. */
export function listHostDirectoryOn(
  client: NodeClient,
  path: string | undefined,
  options: { includeFiles?: boolean; showHidden?: boolean } = {},
): Promise<HostDirectoryListing> {
  return projectsDomain(client)().list_host_directory({
    ...(path ? { path } : {}),
    includeFiles: options.includeFiles ?? false,
    showHidden: options.showHidden ?? false,
  });
}

/** Creates folder `name` inside `parent` on `client`'s host and returns its path. */
export function createHostDirectoryOn(
  client: NodeClient,
  parent: string,
  name: string,
): Promise<{ path: string }> {
  return projectsDomain(client)().create_host_directory({ parent, name });
}
