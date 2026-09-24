import type { DesignCanvas, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignOperationDescriptor,
  DesignOperationStatus,
  DesignSnapshotEnvelope,
} from "@orkestrator/protocol/design-operations";

/** Test support: an in-memory protocol-v2 design backend with strict CAS. */
export const canvasId = "00000000-0000-4000-8000-00000000c001";
export const frameA = "00000000-0000-4000-8000-00000000f00a";
export const frameB = "00000000-0000-4000-8000-00000000f00b";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function until(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface FakeFrame {
  frame: DesignFrame;
  structureId: string;
  contentId: string;
}

/** In-memory v2 backend with strict CAS and injectable barriers. */
export class FakeBackend {
  generation = "gen-1";
  revision = 1;
  statusVersion = 0;
  counter = 10;
  frames = new Map<string, FakeFrame>();
  pending = new Map<string, { descriptor: DesignOperationDescriptor; executing: boolean }>();
  receipts = new Map<string, DesignOperationStatus>();
  correlation = new Map<string, string>();
  calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  executeBarrier?: (descriptor: DesignOperationDescriptor) => Promise<void>;
  loseExecuteResponse = new Set<string>();
  executions: DesignOperationDescriptor[] = [];
  history = { undoCount: 0, redoCount: 0 };
  /** When set, snapshots report a tombstone (even if no hint was delivered). */
  deleted = false;

  constructor() {
    for (const id of [frameA, frameB]) {
      this.frames.set(id, {
        frame: {
          id,
          name: id === frameA ? "A" : "B",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          html: "<p>x</p>",
          revision: 1,
        },
        structureId: `s${this.counter++}`,
        contentId: `c${this.counter++}`,
      });
    }
  }

  canvas(): DesignCanvas {
    return {
      format: "orkdes",
      version: 1,
      id: canvasId,
      environmentId: "env-1",
      name: "Fake",
      revision: this.revision,
      frames: Array.from(this.frames.values()).map((entry) => entry.frame),
    };
  }

  snapshot(): DesignSnapshotEnvelope {
    return {
      kind: "snapshot",
      responseVersion: 1,
      generation: this.generation,
      canvas: structuredClone(this.canvas()),
      workspace: {
        recordSequence: this.revision,
        statusVersion: this.statusVersion,
        incarnation: "fake",
        createdAt: "",
        modifiedAt: "",
        frames: Object.fromEntries(
          Array.from(this.frames.values()).map((entry) => [
            entry.frame.id,
            {
              contentId: entry.contentId,
              structureId: entry.structureId,
              viewportId: "v",
              modifiedAt: "",
              validation: {
                frameId: entry.frame.id,
                contentId: entry.contentId,
                runtimeVersion: 2,
                state: "valid",
                reasons: [],
                truncated: false,
              },
            },
          ]),
        ),
        history: {
          revision: this.revision,
          undoCount: this.history.undoCount,
          redoCount: this.history.redoCount,
          canUndo: this.history.undoCount > 0,
          canRedo: this.history.redoCount > 0,
        },
        sessions: [],
      },
    };
  }

  tombstone() {
    return {
      kind: "deleted" as const,
      responseVersion: 1,
      generation: this.generation,
      canvasId,
      name: "Fake",
      revision: this.revision,
      deletedAt: new Date(0).toISOString(),
      restorable: true,
      statusVersion: this.statusVersion + 1,
    };
  }

  /** Another writer replaces a frame's HTML (structural change). */
  externalReplace(frameId: string) {
    const entry = this.frames.get(frameId)!;
    entry.frame = { ...entry.frame, html: "<p>agent</p>", revision: entry.frame.revision + 1 };
    entry.structureId = `s${this.counter++}`;
    entry.contentId = `c${this.counter++}`;
    this.revision++;
  }

  /** Another writer deletes a frame. */
  removeFrame(frameId: string) {
    this.frames.delete(frameId);
    this.revision++;
  }

  /** Another writer (re)creates a frame with this id at revision 1 and a new identity. */
  addFrame(frameId: string) {
    this.frames.set(frameId, {
      frame: {
        id: frameId,
        name: "Recreated",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        html: "<p>new</p>",
        revision: 1,
      },
      structureId: `s${this.counter++}`,
      contentId: `c${this.counter++}`,
    });
    this.revision++;
  }

  /** Prepares a token outside the client (e.g. in a previous session). */
  prepareToken(descriptor: Omit<DesignOperationDescriptor, "canvasId">): string {
    const token = `op_${crypto.randomUUID()}`;
    this.pending.set(token, { descriptor: { ...descriptor, canvasId }, executing: false });
    return token;
  }

  /** Admits a prepared token without finishing it (status reports `executing`). */
  markExecuting(token: string) {
    this.pending.get(token)!.executing = true;
  }

  /** Finishes an admitted token as the backend would, recording its receipt. */
  completePending(token: string): DesignOperationStatus {
    const entry = this.pending.get(token)!;
    const status = this.apply(token, entry.descriptor);
    this.pending.delete(token);
    this.receipts.set(token, status);
    return status;
  }

  /** Records a terminal receipt (e.g. an expired or unknown outcome). */
  setReceipt(token: string, state: DesignOperationStatus["state"]) {
    this.pending.delete(token);
    this.receipts.set(token, {
      token,
      canvasId,
      kind: "update_frame",
      actor: "user",
      base: {},
      preparedAt: "",
      updatedAt: "",
      state,
    });
  }

  private apply(token: string, descriptor: DesignOperationDescriptor): DesignOperationStatus {
    this.executions.push(descriptor);
    const base = {
      token,
      canvasId,
      kind: descriptor.input.kind,
      actor: "user" as const,
      base: descriptor.preconditions,
      preparedAt: "",
      updatedAt: "",
    };
    const input = descriptor.input as {
      frameId?: string;
      patch?: Partial<DesignFrame>;
      styles?: Record<string, string>;
    };
    const entry = input.frameId ? this.frames.get(input.frameId) : undefined;
    const reject = (message: string): DesignOperationStatus => ({
      ...base,
      state: "rejected",
      failure: { code: "conflict", message, retry: "after-refresh" },
    });
    if (descriptor.input.kind === "undo" || descriptor.input.kind === "redo") {
      if (descriptor.preconditions.canvasRevision !== this.revision)
        return reject("Design revision conflict");
      this.revision++;
      if (descriptor.input.kind === "undo") {
        this.history.undoCount--;
        this.history.redoCount++;
      } else {
        this.history.undoCount++;
        this.history.redoCount--;
      }
      return { ...base, state: "committed", result: { canvasRevision: this.revision, frames: [] } };
    }
    if (!entry) return reject("missing frame");
    if (descriptor.preconditions.frameRevision !== entry.frame.revision)
      return reject(
        `Design revision conflict: expected ${descriptor.preconditions.frameRevision}, current ${entry.frame.revision}`,
      );
    if (
      descriptor.preconditions.structureId &&
      descriptor.preconditions.structureId !== entry.structureId
    )
      return reject("The frame structure changed; reselect the element");
    if (descriptor.input.kind === "update_frame") {
      entry.frame = { ...entry.frame, ...input.patch, revision: entry.frame.revision + 1 };
    } else if (descriptor.input.kind === "set_element_styles") {
      entry.frame = {
        ...entry.frame,
        html: `${entry.frame.html}<!--${JSON.stringify(input.styles)}-->`,
        revision: entry.frame.revision + 1,
      };
      entry.contentId = `c${this.counter++}`;
    }
    this.revision++;
    return {
      ...base,
      state: "committed",
      result: {
        canvasRevision: this.revision,
        frames: [
          {
            frameId: entry.frame.id,
            revision: entry.frame.revision,
            identity: {
              contentId: entry.contentId,
              structureId: entry.structureId,
              viewportId: "v",
            },
          },
        ],
      },
    };
  }

  async handle(command: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ command, args });
    const ok = (value: unknown) => ({ ok: true, value });
    switch (command) {
      case "design_capabilities":
        return ok({ protocolVersion: 2, responseVersion: 1 });
      case "design_snapshot":
        return ok(this.deleted ? this.tombstone() : this.snapshot());
      case "design_sync": {
        if (this.deleted) return ok(this.tombstone());
        if (
          args.generation === this.generation &&
          args.after === this.revision &&
          args.statusVersion === this.statusVersion
        )
          return ok({
            kind: "unchanged",
            responseVersion: 1,
            generation: this.generation,
            revision: this.revision,
            statusVersion: this.statusVersion,
          });
        return ok(this.snapshot());
      }
      case "design_prepare": {
        const descriptor = args.descriptor as DesignOperationDescriptor;
        const existing = descriptor.correlationId
          ? this.correlation.get(descriptor.correlationId)
          : undefined;
        if (existing) return ok({ token: existing, canvasId, state: "prepared", expiresAt: "" });
        const token = `op_${crypto.randomUUID()}`;
        this.pending.set(token, { descriptor, executing: false });
        if (descriptor.correlationId) this.correlation.set(descriptor.correlationId, token);
        return ok({ token, canvasId, state: "prepared", expiresAt: "" });
      }
      case "design_execute": {
        const token = String(args.token);
        const receipt = this.receipts.get(token);
        if (receipt) return ok(receipt);
        const entry = this.pending.get(token);
        if (!entry)
          return ok({
            token,
            canvasId,
            state: "unknown",
            kind: "update_frame",
            actor: "system",
            base: {},
            preparedAt: "",
            updatedAt: "",
          });
        entry.executing = true;
        await this.executeBarrier?.(entry.descriptor);
        const status = this.apply(token, entry.descriptor);
        this.pending.delete(token);
        this.receipts.set(token, status);
        if (this.loseExecuteResponse.delete(token)) throw new Error("Failed to fetch");
        return ok(status);
      }
      case "design_operation_status": {
        const token = String(args.token);
        const receipt = this.receipts.get(token);
        if (receipt) return ok(receipt);
        const entry = this.pending.get(token);
        return ok({
          token,
          canvasId,
          kind: "update_frame",
          actor: "user",
          base: {},
          preparedAt: "",
          updatedAt: "",
          state: entry ? (entry.executing ? "executing" : "prepared") : "unknown",
        });
      }
      case "design_cancel": {
        const token = String(args.token);
        this.pending.delete(token);
        const status = {
          token,
          canvasId,
          kind: "update_frame",
          actor: "user",
          base: {},
          preparedAt: "",
          updatedAt: "",
          state: "canceled",
        };
        this.receipts.set(token, status as DesignOperationStatus);
        return ok(status);
      }
      default:
        throw new Error(`Unknown backend command: ${command}`);
    }
  }
}
