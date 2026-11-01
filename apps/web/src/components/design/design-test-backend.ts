import type { DesignCanvas, DesignFrame } from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_NOT_RUN_STATES,
  rebaseOverOwnCommits,
  type DesignFailure,
  type DesignIntentDraft,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
  type DesignSnapshotEnvelope,
  type DesignStoredIntent,
  type DesignSyncResult,
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
  syncReplies: DesignSyncResult[] = [];
  history = { undoCount: 0, redoCount: 0 };
  /** When set, snapshots report a tombstone (even if no hint was delivered). */
  deleted = false;
  /** Reports the backend-owned intent queue; false acts as an older v2 backend. */
  intentsEnabled = true;
  intents: DesignStoredIntent[] = [];
  /** Refuses new intents once the queue holds this many. */
  intentCapacity?: number;
  /** Tokens actually minted (`prepareToken` seeds an earlier session's and is not counted). */
  prepareCount = 0;
  /** The backend's clock for `updatedAt` and listing. */
  now = 1_000_000;
  private readonly runningIntents = new Set<string>();

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
      ...(descriptor.clientId ? { clientId: descriptor.clientId } : {}),
      ...(descriptor.correlationId ? { correlationId: descriptor.correlationId } : {}),
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
    if (descriptor.input.kind === "delete_frame") {
      this.removeFrame(entry.frame.id);
      return { ...base, state: "committed", result: { canvasRevision: this.revision, frames: [] } };
    }
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

  private prepareDescriptor(
    descriptor: DesignOperationDescriptor,
  ): { token: string } | { failure: DesignFailure } {
    const existing = descriptor.correlationId
      ? this.correlation.get(descriptor.correlationId)
      : undefined;
    if (existing) {
      if (JSON.stringify(this.pending.get(existing)?.descriptor) !== JSON.stringify(descriptor))
        return {
          failure: {
            code: "invalid-input",
            message: "This correlation id was already used for a different edit",
            retry: "never",
          },
        };
      return { token: existing };
    }
    const token = `op_${crypto.randomUUID()}`;
    this.prepareCount++;
    this.pending.set(token, { descriptor, executing: false });
    if (descriptor.correlationId) this.correlation.set(descriptor.correlationId, token);
    return { token };
  }

  private async executeToken(token: string): Promise<DesignOperationStatus> {
    const receipt = this.receipts.get(token);
    if (receipt) return receipt;
    const entry = this.pending.get(token);
    if (!entry) return this.statusOf(token);
    entry.executing = true;
    await this.executeBarrier?.(entry.descriptor);
    const status = this.apply(token, entry.descriptor);
    this.pending.delete(token);
    this.receipts.set(token, status);
    return status;
  }

  private statusOf(token: string): DesignOperationStatus {
    const receipt = this.receipts.get(token);
    if (receipt) return receipt;
    const entry = this.pending.get(token);
    return {
      token,
      canvasId,
      kind: "update_frame",
      actor: entry ? "user" : "system",
      base: {},
      preparedAt: "",
      updatedAt: "",
      state: entry ? (entry.executing ? "executing" : "prepared") : "unknown",
    };
  }

  private current() {
    return {
      canvasRevision: this.revision,
      frames: new Map(
        Array.from(this.frames.values()).map((entry) => [
          entry.frame.id,
          { revision: entry.frame.revision, structureId: entry.structureId },
        ]),
      ),
    };
  }

  /** The backend's rule: an authoritative status decides the stored intent. */
  private applyStatus(intent: DesignStoredIntent, status: DesignOperationStatus) {
    intent.token = status.token;
    if (status.state === "prepared" || status.state === "executing") {
      intent.phase = "admitted";
      if (status.state === "executing") intent.outcome = "executing";
      else delete intent.outcome;
      return;
    }
    intent.phase = "settled";
    intent.outcome = status.state;
    if (status.result) intent.result = status.result;
    if (status.state === "committed" || status.state === "no-op") delete intent.failure;
    else
      intent.failure = status.failure ?? {
        code: "unknown-outcome",
        message: `This edit was ${status.state}`,
        retry: "review",
      };
  }

  private async handleIntent(
    command: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; failure: DesignFailure }> {
    const ok = (value: unknown) => ({ ok: true as const, value });
    const fail = (failure: DesignFailure) => ({ ok: false as const, failure });
    const find = (id: unknown) => this.intents.find((intent) => intent.id === id);
    const clone = (intent: DesignStoredIntent | undefined) => structuredClone(intent);
    switch (command) {
      case "design_intents": {
        for (const intent of this.intents) {
          if (this.runningIntents.has(intent.id)) continue;
          if (intent.phase === "preparing") {
            const token = this.correlation.get(intent.descriptor.correlationId ?? "");
            if (!token) {
              intent.phase = "draft";
              continue;
            }
            intent.phase = "admitted";
            intent.token = token;
          }
          const unresolved =
            intent.phase === "admitted" ||
            (intent.phase === "settled" && intent.outcome === "unknown");
          if (intent.token && unresolved) this.applyStatus(intent, this.statusOf(intent.token));
        }
        return ok({
          intents: structuredClone(this.intents),
          sending: Array.from(this.runningIntents),
          now: this.now,
        });
      }
      case "design_intent_save": {
        const clientId = String(args.clientId);
        const saved: string[] = [];
        for (const draft of args.drafts as DesignIntentDraft[]) {
          const existing = find(draft.id);
          if (existing && (existing.phase !== "draft" || existing.clientId !== clientId)) continue;
          if (
            !existing &&
            this.intentCapacity !== undefined &&
            this.intents.length >= this.intentCapacity
          )
            return fail({ code: "capacity", message: "Too many", retry: "after-delay" });
          const intent: DesignStoredIntent = {
            ...structuredClone(draft),
            clientId,
            phase: "draft",
            updatedAt: this.now,
          };
          if (existing) this.intents[this.intents.indexOf(existing)] = intent;
          else this.intents.push(intent);
          saved.push(draft.id);
        }
        return ok({ saved });
      }
      case "design_intent_import": {
        let imported = 0;
        const entries = args.intents as Array<
          Omit<DesignStoredIntent, "phase"> & {
            phase: string;
            environmentId?: string;
            canvasId?: string;
          }
        >;
        for (const entry of entries) {
          if (find(entry.id)) continue;
          const settled = entry.phase === "settled";
          const { environmentId: _e, canvasId: _c, ...rest } = entry;
          this.intents.push({
            ...structuredClone(rest),
            clientId: entry.descriptor.clientId ?? String(args.clientId),
            phase: entry.token ? (settled ? "settled" : "admitted") : "draft",
            ...(entry.token && !settled && entry.phase !== "prepared"
              ? { outcome: "unknown" as const }
              : {}),
            updatedAt: this.now,
          });
          imported++;
        }
        return ok({ imported, skipped: entries.length - imported });
      }
      case "design_intent_run": {
        const draft = args.intent as DesignIntentDraft;
        const clientId = draft.descriptor.clientId!;
        const existing = find(draft.id);
        if (existing && existing.clientId !== clientId)
          return fail({ code: "conflict", message: "Another window", retry: "never" });
        if (existing && existing.phase !== "draft" && existing.phase !== "preparing")
          return ok({ intent: clone(existing) });
        if (
          !existing &&
          this.intentCapacity !== undefined &&
          this.intents.length >= this.intentCapacity
        )
          return fail({ code: "capacity", message: "Too many", retry: "after-delay" });
        const intent: DesignStoredIntent = {
          ...structuredClone(draft),
          clientId,
          updatedAt: this.now,
          phase: "preparing",
          descriptor:
            existing?.phase === "preparing"
              ? existing.descriptor
              : rebaseOverOwnCommits(
                  { ...draft.descriptor, canvasId },
                  Array.from(this.receipts.values()),
                  this.current(),
                ),
        };
        if (existing) this.intents[this.intents.indexOf(existing)] = intent;
        else this.intents.push(intent);
        this.runningIntents.add(draft.id);
        try {
          const prepared = this.prepareDescriptor(intent.descriptor);
          if ("failure" in prepared) {
            intent.phase = "settled";
            intent.outcome = "rejected";
            intent.failure = prepared.failure;
            return ok({ intent: clone(intent), failure: prepared.failure });
          }
          const status = await this.executeToken(prepared.token);
          if (find(draft.id) === intent) this.applyStatus(intent, status);
          if (this.loseExecuteResponse.delete(prepared.token)) throw new Error("Failed to fetch");
          return ok({ intent: clone(find(draft.id)), status });
        } finally {
          this.runningIntents.delete(draft.id);
        }
      }
      case "design_intent_resume": {
        const current = find(args.intentId);
        if (!current)
          return fail({ code: "not-found", message: "No longer pending", retry: "never" });
        const clientId = String(args.clientId);
        const notRun =
          current.outcome !== undefined && DESIGN_NOT_RUN_STATES.includes(current.outcome);
        current.clientId = clientId;
        delete current.failure;
        if (current.token && !notRun) {
          current.phase = "admitted";
          current.outcome = current.outcome === "executing" ? "executing" : "unknown";
          const status = this.statusOf(current.token);
          this.applyStatus(
            current,
            status.state === "prepared" ? await this.executeToken(current.token) : status,
          );
          return ok({ intent: clone(current) });
        }
        const rebaseTo = args.rebaseTo as DesignStoredIntent["descriptor"]["preconditions"];
        current.descriptor = {
          ...current.descriptor,
          clientId,
          correlationId: `i-${crypto.randomUUID()}`,
          ...(rebaseTo ? { preconditions: rebaseTo } : {}),
        };
        current.phase = "draft";
        delete current.token;
        delete current.outcome;
        delete current.result;
        return ok({ intent: clone(current) });
      }
      case "design_intent_discard": {
        const current = find(args.intentId);
        if (!current) return ok({ discarded: false, mayStillFinish: false });
        let mayStillFinish = this.runningIntents.has(current.id);
        if (current.token && current.phase !== "settled") {
          const entry = this.pending.get(current.token);
          if (entry?.executing) mayStillFinish = true;
          else if (entry) this.pending.delete(current.token);
        }
        this.intents.splice(this.intents.indexOf(current), 1);
        return ok({ discarded: true, mayStillFinish });
      }
      default:
        throw new Error(`Unknown backend command: ${command}`);
    }
  }

  async handle(command: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ command, args });
    const ok = (value: unknown) => ({ ok: true, value });
    if (command.startsWith("design_intent")) {
      if (!this.intentsEnabled) throw new Error(`Unknown backend command: ${command}`);
      return this.handleIntent(command, args);
    }
    switch (command) {
      case "design_capabilities":
        return ok({
          protocolVersion: 2,
          responseVersion: 1,
          ...(this.intentsEnabled ? { intents: true } : {}),
        });
      case "design_snapshot":
        return ok(this.deleted ? this.tombstone() : this.snapshot());
      case "design_sync": {
        const scripted = this.syncReplies.shift();
        if (scripted) return ok(scripted);
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
        const prepared = this.prepareDescriptor(args.descriptor as DesignOperationDescriptor);
        if ("failure" in prepared) return { ok: false, failure: prepared.failure };
        return ok({ token: prepared.token, canvasId, state: "prepared", expiresAt: "" });
      }
      case "design_execute": {
        const token = String(args.token);
        const status = await this.executeToken(token);
        if (this.loseExecuteResponse.delete(token)) throw new Error("Failed to fetch");
        return ok(status);
      }
      case "design_operation_status":
        return ok(this.statusOf(String(args.token)));
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
