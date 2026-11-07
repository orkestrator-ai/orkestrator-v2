/**
 * Copying a project between machines, through the command node (see
 * `@orkestrator/protocol/project-copy`). The command node runs every copy,
 * whichever two machines it is between; this client only starts one and
 * follows its progress.
 */

import {
  PROJECT_COPY_CHANGED_EVENT,
  type ProjectCopyOptions,
  type ProjectCopyRecord,
} from "@orkestrator/protocol/project-copy";
import type { UnlistenFn } from "@/lib/native/events";
import { portalNodesApi } from "@/lib/node-scope/domains/nodes";
import { commandScopeListen } from "./command-scope";

export function getProjectCopyOptions(
  nodeId: string,
  projectId: string,
): Promise<ProjectCopyOptions> {
  return portalNodesApi().get_project_copy_options({ nodeId, projectId });
}

export function copyProjectToNode(input: {
  requestKey: string;
  source: { nodeId: string; projectId: string };
  target: { nodeId: string; location?: string };
  paths: string[];
  rememberFiles: boolean;
}): Promise<ProjectCopyRecord> {
  return portalNodesApi().copy_project_to_node(input);
}

export async function listProjectCopies(): Promise<ProjectCopyRecord[]> {
  const value = await portalNodesApi().list_project_copies({});
  return Array.isArray(value) ? value : [];
}

/** Any copy changed stage or progress; re-read with `listProjectCopies`. */
export function listenProjectCopies(onChange: () => void): Promise<UnlistenFn> {
  return commandScopeListen(PROJECT_COPY_CHANGED_EVENT, () => onChange());
}
