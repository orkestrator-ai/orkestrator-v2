/**
 * The services each node scope runs, and the one place that starts them
 * (plan item 3014, report §7.4).
 *
 * Before, `App.tsx` started six module singletons once for the one backend.
 * Each is now a scoped service (`defineScopedService`, `lib/node-scope`): it
 * runs for one node scope, owns an `AbortSignal`, and stops when its handle is
 * stopped or its scope is disposed. A service that fails (its `start` throws,
 * or its `done` rejects) marks only its own scope `failed` (report §10.3).
 *
 * | Service | Runs on | Why |
 * | --- | --- | --- |
 * | `resource-sync` | every scope | the node's change feed and manifest reads |
 * | `store-resource-sync` | every scope | the store bindings; on a non-command scope only the `every-scope` registrations |
 * | `transport-connectivity` | every scope | the node's main-stream outages pause that node's reads |
 * | `data-saving-read-policy` | command scope | window-level: feeds the window's read policy |
 * | `pane-layout-persistence` | command scope | its store is a command-scope singleton until plan item 3013 |
 * | `build-pipeline-completion-notes` | command scope | its stores are command-scope singletons until 3011 and 3013 |
 * | `node-snapshot` | every scope | a leaf writes its local snapshot; the command scope drops removed nodes' (4003) |
 *
 * `COMMAND_SCOPE_SERVICES` is what `App` starts for the command scope.
 * `WARM_SCOPE_SERVICES` is the light set a later warm scope starts (plan item
 * 4002's lifecycle manager, report §8.1: a warm scope has its main stream and
 * light stores, no heavy data).
 *
 * Effect: each running service's lifetime is a child Effect `Scope` of its
 * node scope's (2001's `Lifetime`), so disposal order and idempotence come from
 * Effect. The service list itself is a plain array, not a `Layer`: the
 * services provide nothing to each other through a context, they need only a
 * start order, and React starts them synchronously.
 */

import {
  getResourceRevisionManifest,
  getScopedResourceRevisionManifest,
  getScopedResourceSnapshots,
} from "@/lib/backend";
import { buildPipelineCompletionNotesService } from "@/lib/build-pipeline-completion-notes";
import { dataSavingReadPolicyService } from "@/lib/data-saving";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import {
  defineScopedService,
  type ScopedServiceDef,
  type ScopedServiceHandle,
} from "@/lib/node-scope/scoped-service";
import { scopeBackendClient } from "@/lib/backend/client";
import { systemApi } from "@/lib/node-scope/domains/system";
import { isAppCommandScope } from "@/lib/node-scope-slots";
import { nodeSnapshotService } from "@/lib/node-snapshots";
import { paneLayoutPersistenceService } from "@/lib/pane-layout-persistence";
import { startResourceSync, type ResourceSyncOptions } from "@/lib/resource-sync";
import { storeResourceSyncService } from "@/lib/store-resource-sync";
import { transportConnectivityService } from "@/lib/transport-connectivity";
import { windowSelectionPersistenceService } from "@/stores/windowSelectionStore";
import {
  isResourceRevisionManifest,
  isScopedResourceRevisionManifest,
  isScopedResourceSnapshotBatch,
} from "@orkestrator/protocol/resource-events";

/**
 * The manifest reads for `scope`'s node. The app's command scope keeps the
 * `@/lib/backend` reads (what suites mock); any other scope sends the same
 * commands through its own client, with the same response checks.
 */
export function scopeResourceSyncOptions(scope: NodeScope): ResourceSyncOptions {
  if (isAppCommandScope(scope)) {
    return {
      loadManifest: getResourceRevisionManifest,
      loadScopedManifest: getScopedResourceRevisionManifest,
      loadScopedSnapshots: getScopedResourceSnapshots,
    };
  }
  // Version 1 for a node that advertises `system`; today's call otherwise.
  const system = () => systemApi(scopeBackendClient(scope));
  const read = async <T>(
    command: string,
    response: Promise<unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<T> => {
    const value = await response;
    if (!valid(value)) throw new Error(`Invalid ${command} response`);
    return value;
  };
  return {
    loadManifest: (knownGeneration, knownRevisions = {}) =>
      read(
        "get_resource_revision_manifest",
        system().get_resource_revision_manifest({
          ...(knownGeneration === undefined ? {} : { knownGeneration }),
          knownRevisions,
        }),
        isResourceRevisionManifest,
      ),
    loadScopedManifest: (knownGeneration, cursor, knownRevisions, highWater) =>
      read(
        "get_scoped_resource_revision_manifest",
        system().get_scoped_resource_revision_manifest({
          ...(knownGeneration === undefined ? {} : { knownGeneration }),
          cursor,
          knownRevisions,
          ...(highWater === undefined ? {} : { highWater }),
        }),
        isScopedResourceRevisionManifest,
      ),
    loadScopedSnapshots: (changes) =>
      read(
        "get_scoped_resource_snapshots",
        system().get_scoped_resource_snapshots({ changes }),
        isScopedResourceSnapshotBatch,
      ),
  };
}

/**
 * The node's change feed (`resource-sync.ts`) as a scoped service. The feed
 * must be attached before the store bindings that consume it, and both before
 * anything that reads a backend snapshot, so it comes first in every list.
 */
export const resourceSyncService = defineScopedService("resource-sync", (scope) => ({
  stop: startResourceSync(scopeResourceSyncOptions(scope), scope),
}));

/**
 * The light set: the main stream, its store bindings and its connectivity,
 * then the node's pane-layout persistence (the layout the bindings adopt and
 * the writes a tab change makes) and its completion notes, which open a tab in
 * that layout (plan item 3013), and its local snapshot (plan item 4003).
 */
export const WARM_SCOPE_SERVICES: readonly ScopedServiceDef[] = [
  resourceSyncService,
  storeResourceSyncService,
  transportConnectivityService,
  paneLayoutPersistenceService,
  buildPipelineCompletionNotesService,
  nodeSnapshotService,
];

/** Everything `App` starts for the command scope, in start order. */
export const COMMAND_SCOPE_SERVICES: readonly ScopedServiceDef[] = [
  ...WARM_SCOPE_SERVICES,
  dataSavingReadPolicyService,
  windowSelectionPersistenceService,
];

/**
 * Starts `services` on `scope` in order (one already running is reused) and
 * returns the stop, which stops them in reverse order. A service that fails
 * to start marks the scope failed and the rest still start.
 *
 * `App` calls this for the command scope and stops on unmount: the App root is
 * the command scope's lifecycle owner until plan item 4002's manager, and it
 * unmounts only with the window. Disposing the scope stops them too.
 */
export function startScopeServices(
  scope: NodeScope,
  services: readonly ScopedServiceDef[],
): () => void {
  const handles: ScopedServiceHandle[] = services.map((service) => scope.service(service));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const handle of handles.slice().reverse()) handle.stop();
  };
}
