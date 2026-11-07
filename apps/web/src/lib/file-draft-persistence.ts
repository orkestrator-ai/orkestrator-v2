import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createWorkflowsApi, type WorkflowsApi } from "@/lib/backend/workflows";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import {
  createDraftRevisionState,
  DraftRevisionConflictError,
  type DraftRevisionState,
  isDraftRevisionConflict,
} from "@/lib/draft-conflict";

const desktopClients = new WeakMap<DraftRevisionState, string>();

function releaseDesktopClient(state: DraftRevisionState): void {
  const clientId = desktopClients.get(state);
  if (!clientId) return;
  desktopClients.delete(state);
  const host = typeof window !== "undefined" ? window.orkestratorDesktopHost : undefined;
  void host?.api.invoke("desktop_file_draft_release", { clientId }).catch(() => undefined);
}

/**
 * One node's draft writes (plan item 3012, report Appendix B): the write
 * chain per draft key and the revision states, so a draft key (which names
 * an environment id, unique only on its node) never orders or fences another
 * node's writes. Every export takes an optional trailing `scope`, the app's
 * command scope when omitted.
 */
interface FileDraftWrites {
  writeChains: Map<string, Promise<void>>;
  defaultRevisionStates: Map<string, DraftRevisionState>;
  clientRevisionStates: Map<string, DraftRevisionState>;
}

const fileDraftWrites = defineScopedSlot<FileDraftWrites>("file-draft-writes", () => ({
  writeChains: new Map(),
  defaultRevisionStates: new Map(),
  clientRevisionStates: new Map(),
}));

/** `scope`'s node's draft commands (the mocked named exports on the app's command scope). */
function draftApi(scope: NodeScope) {
  return backendApiForScope(scope, createWorkflowsApi, backend);
}

export { createDraftRevisionState };
export type { DraftRevisionState };

function revisionStateFor(
  writes: FileDraftWrites,
  draftKey: string,
  state?: DraftRevisionState,
): DraftRevisionState {
  if (state) return state;
  const existing = writes.defaultRevisionStates.get(draftKey);
  if (existing) return existing;
  const created = createDraftRevisionState();
  writes.defaultRevisionStates.set(draftKey, created);
  return created;
}

export function getFileDraftRevisionState(
  clientId: string,
  scope: NodeScope = appCommandScope(),
): DraftRevisionState {
  const { clientRevisionStates } = fileDraftWrites(scope);
  const existing = clientRevisionStates.get(clientId);
  if (existing) return existing;
  const created = createDraftRevisionState();
  clientRevisionStates.set(clientId, created);
  return created;
}

export function releaseFileDraftRevisionState(
  clientId: string,
  scope: NodeScope = appCommandScope(),
): void {
  if (scope.disposed) return;
  const { clientRevisionStates } = fileDraftWrites(scope);
  const state = clientRevisionStates.get(clientId);
  if (state) releaseDesktopClient(state);
  clientRevisionStates.delete(clientId);
}

async function recordFileConflict(
  scope: NodeScope,
  draftKey: string,
  state: DraftRevisionState,
  error: unknown,
): Promise<never> {
  if (!isDraftRevisionConflict(error)) throw error;
  const current = await draftApi(scope).getFileDraft(draftKey);
  state.conflictRevision = current?.revision ?? 0;
  throw new DraftRevisionConflictError(draftKey, state.conflictRevision, { cause: error });
}

export function fileDraftKey(environmentId: string, filePath: string): string {
  return `file:${environmentId}:${encodeURIComponent(filePath)}`;
}

function enqueue(
  writeChains: Map<string, Promise<void>>,
  draftKey: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const previous = writeChains.get(draftKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .then(() => undefined);
  writeChains.set(draftKey, next);
  void next.then(
    () => {
      if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
    },
    () => {
      if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
    },
  );
  return next;
}

/** Read only after every queued write for this file has settled. */
export async function loadFileDraft(
  environmentId: string,
  filePath: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<Awaited<ReturnType<WorkflowsApi["getFileDraft"]>> | null> {
  const draftKey = fileDraftKey(environmentId, filePath);
  // Held across awaits: the scope may be disposed while a read is in flight.
  const writes = fileDraftWrites(scope);
  await (writes.writeChains.get(draftKey) ?? Promise.resolve()).catch(() => undefined);
  const draft = await draftApi(scope).getFileDraft(draftKey);
  const state = revisionStateFor(writes, draftKey, revisionState);
  releaseDesktopClient(state);
  state.revision = draft?.revision ?? 0;
  state.conflictRevision = null;
  return draft;
}

/**
 * Hand off immediately: main owns ordering even if this renderer disappears.
 * Main writes to the window's command node, so only the command scope's
 * drafts are handed off; another node's go through its own client.
 */
function desktopWrite(
  scope: NodeScope,
  writes: FileDraftWrites,
  command: "save_file_draft" | "delete_file_draft",
  draftKey: string,
  state: DraftRevisionState,
  args: Record<string, unknown>,
): Promise<void> | null {
  const host = typeof window !== "undefined" ? window.orkestratorDesktopHost : undefined;
  if (!host || scope.role !== "command") return null;
  const { writeChains } = writes;
  if (state.conflictRevision !== null) {
    return Promise.reject(new DraftRevisionConflictError(draftKey, state.conflictRevision));
  }
  let clientId = desktopClients.get(state);
  if (!clientId) {
    clientId = crypto.randomUUID();
    desktopClients.set(state, clientId);
  }
  const write = host.api
    .invoke<{ revision: number } | null>("desktop_file_draft_write", {
      ...args,
      command,
      draftKey,
      clientId,
      expectedRevision: state.revision,
    })
    .then((saved) => {
      state.revision = saved?.revision ?? 0;
    })
    .catch((error: unknown) => {
      if (desktopClients.get(state) === clientId) releaseDesktopClient(state);
      return recordFileConflict(scope, draftKey, state, error);
    });
  writeChains.set(draftKey, write);
  void write
    .finally(() => {
      if (writeChains.get(draftKey) === write) writeChains.delete(draftKey);
    })
    .catch(() => undefined);
  return write;
}

export function persistFileDraft(
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const writes = fileDraftWrites(scope);
  const state = revisionStateFor(writes, draftKey, revisionState);
  const handedOff = desktopWrite(scope, writes, "save_file_draft", draftKey, state, {
    environmentId,
    filePath,
    content,
    originalContent,
  });
  if (handedOff) return handedOff;
  return enqueue(writes.writeChains, draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(draftKey, state.conflictRevision);
    }
    try {
      const saved = await draftApi(scope).saveFileDraft(
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        state.revision,
      );
      if (saved && typeof saved.revision === "number") {
        state.revision = saved.revision;
      }
    } catch (error) {
      await recordFileConflict(scope, draftKey, state, error);
    }
  });
}

export function discardFileDraft(
  environmentId: string,
  filePath: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const writes = fileDraftWrites(scope);
  const state = revisionStateFor(writes, draftKey, revisionState);
  const handedOff = desktopWrite(scope, writes, "delete_file_draft", draftKey, state, {});
  if (handedOff) return handedOff;
  return enqueue(writes.writeChains, draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(draftKey, state.conflictRevision);
    }
    try {
      await draftApi(scope).deleteFileDraft(draftKey, state.revision);
      state.revision = 0;
    } catch (error) {
      await recordFileConflict(scope, draftKey, state, error);
    }
  });
}

export function resolveFileDraftSaveConflict(
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const state = revisionStateFor(fileDraftWrites(scope), draftKey, revisionState);
  if (state.conflictRevision !== null) {
    releaseDesktopClient(state);
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return persistFileDraft(environmentId, filePath, content, originalContent, state, scope);
}

export function resolveFileDraftDiscardConflict(
  environmentId: string,
  filePath: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const state = revisionStateFor(fileDraftWrites(scope), draftKey, revisionState);
  if (state.conflictRevision !== null) {
    releaseDesktopClient(state);
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return discardFileDraft(environmentId, filePath, state, scope);
}
