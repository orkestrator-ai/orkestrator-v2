import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DESIGN_CONFLICT,
  DESIGN_EVENT,
  DESIGN_HISTORY_LIMIT,
  DESIGN_HISTORY_MAX_BYTES,
  DESIGN_MAX_DOCUMENT_BYTES,
  DESIGN_MAX_FRAMES,
  DESIGN_MAX_HTML_BYTES,
  type DesignCanvas,
  type DesignCanvasState,
  type DesignChange,
  type DesignChanges,
  type DesignFrame,
  type DesignHistoryStatus,
  type DesignOperation,
} from "@orkestrator/protocol/design-canvas";
import { DesignRenderer } from "./design-renderer.js";

export const designId = z.string().uuid();
const name = z.string().trim().min(1).max(120);
export const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const htmlSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= DESIGN_MAX_HTML_BYTES, "HTML exceeds 256 KiB");
export const frameSchema = z
  .object({
    id: designId,
    name,
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().int().min(32).max(4096),
    height: z.number().int().min(32).max(4096),
    html: htmlSchema,
    revision,
  })
  .strict();
export const canvasSchema = z
  .object({
    format: z.literal("orkdes"),
    version: z.literal(1),
    id: designId,
    environmentId: z.string().min(1).max(256),
    name,
    revision,
    frames: z.array(frameSchema).max(DESIGN_MAX_FRAMES),
  })
  .strict()
  .refine(
    (value) => new Set(value.frames.map((frame) => frame.id)).size === value.frames.length,
    "Duplicate frame ids",
  );

type DesignHistoryEntry =
  | {
      kind: "create-frame";
      index: number;
      after: DesignFrame;
    }
  | {
      kind: "update-frame";
      frameId: string;
      before: DesignFramePatch;
      after: DesignFramePatch;
    };

interface DesignHistory {
  undo: DesignHistoryEntry[];
  redo: DesignHistoryEntry[];
  bytes: number;
  lastUsed: number;
}

type DesignFramePatch = Partial<
  Pick<DesignFrame, "name" | "x" | "y" | "width" | "height" | "html">
>;

const FRAME_MUTABLE_FIELDS = ["name", "x", "y", "width", "height", "html"] as const;

function copyFrame(frame: DesignFrame): DesignFrame {
  return { ...frame };
}

function frameDelta(before: DesignFrame, after: DesignFrame) {
  const previous: DesignFramePatch = {};
  const next: DesignFramePatch = {};
  for (const field of FRAME_MUTABLE_FIELDS) {
    if (before[field] === after[field]) continue;
    Object.assign(previous, { [field]: before[field] });
    Object.assign(next, { [field]: after[field] });
  }
  return { before: previous, after: next };
}

function historyEntryBytes(entry: DesignHistoryEntry): number {
  return Buffer.byteLength(JSON.stringify(entry));
}

export class DesignService {
  readonly generation = randomUUID();
  private readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly events: DesignChange[] = [];
  private readonly metadata = new Map<string, { environmentId: string; revision: number }>();
  private readonly histories = new Map<string, DesignHistory>();
  private historyBytes = 0;
  private historyClock = 0;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  constructor(
    dataDir: string,
    private readonly emit: (event: string, payload: unknown) => void,
    readonly renderer = new DesignRenderer(),
  ) {
    this.root = join(dataDir, "design-canvases");
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 32) throw new Error("Design write queue full; retry later");
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      this.pending--;
    }
  }
  private file(id: string) {
    return join(this.root, `${designId.parse(id)}.orkdes`);
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      this.metadata.clear();
      for (const file of await readdir(this.root)) {
        if (!file.endsWith(".orkdes")) continue;
        try {
          const canvas = await this.read(file.slice(0, -7));
          this.metadata.set(canvas.id, {
            environmentId: canvas.environmentId,
            revision: canvas.revision,
          });
        } catch (error) {
          console.warn(
            `[backend] Skipping unreadable design canvas ${file}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      this.initialized = true;
    })().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }
  private async read(id: string): Promise<DesignCanvas> {
    const handle = await open(this.file(id), "r");
    try {
      const stat = await handle.stat();
      if (stat.size > DESIGN_MAX_DOCUMENT_BYTES) throw new Error("Design file exceeds 4 MiB");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > stat.size) throw new Error("Design file changed during read");
      const canvas = canvasSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      if (canvas.id !== id) throw new Error("Canvas id does not match its filename");
      return canvas;
    } finally {
      await handle.close();
    }
  }
  async get(id: string, environmentId?: string): Promise<DesignCanvas> {
    await this.initialize();
    const canvas = await this.read(id);
    if (environmentId && canvas.environmentId !== environmentId)
      throw new Error("Canvas not found in this environment");
    this.metadata.set(canvas.id, {
      environmentId: canvas.environmentId,
      revision: canvas.revision,
    });
    return canvas;
  }
  async list(environmentId: string) {
    await this.initialize();
    const result: Array<{ id: string; name: string; revision: number }> = [];
    for (const [id, metadata] of this.metadata) {
      if (metadata.environmentId !== environmentId) continue;
      try {
        const canvas = await this.get(id, environmentId);
        result.push({ id: canvas.id, name: canvas.name, revision: canvas.revision });
      } catch (error) {
        this.metadata.delete(id);
        console.warn(
          `[backend] Skipping unreadable design canvas ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return result;
  }
  hasCanvases(environmentId: string): boolean {
    for (const metadata of this.metadata.values()) {
      if (metadata.environmentId === environmentId) return true;
    }
    return false;
  }
  private async commit(canvas: DesignCanvas, frameId?: string, beforePublish?: () => void) {
    canvasSchema.parse(canvas);
    // Use the export representation for the limit too, so every saved canvas
    // can be imported again without pretty-printing pushing it over the bound.
    const bytes = Buffer.from(JSON.stringify(canvas, null, 2));
    if (bytes.byteLength > DESIGN_MAX_DOCUMENT_BYTES) throw new Error("Canvas exceeds 4 MiB");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.file(canvas.id),
      temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
      // Publish the in-memory state synchronously with the durable rename. No
      // reader can observe the new revision before its history and metadata.
      beforePublish?.();
      const event: DesignChange = {
        canvasId: canvas.id,
        revision: canvas.revision,
        ...(frameId ? { frameId } : {}),
      };
      this.events.push(event);
      this.metadata.set(canvas.id, {
        environmentId: canvas.environmentId,
        revision: canvas.revision,
      });
      if (this.events.length > 256) this.events.shift();
      // Content-free bounded hints; clients read snapshots and detect gaps.
      this.emit(DESIGN_EVENT, { ...event, generation: this.generation });
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  private history(canvasId: string): DesignHistory {
    let history = this.histories.get(canvasId);
    if (!history) {
      history = { undo: [], redo: [], bytes: 0, lastUsed: ++this.historyClock };
      this.histories.set(canvasId, history);
    }
    return history;
  }
  private refreshHistory(canvasId: string, history: DesignHistory): void {
    this.historyBytes -= history.bytes;
    history.bytes = [...history.undo, ...history.redo].reduce(
      (total, entry) => total + historyEntryBytes(entry),
      0,
    );
    history.lastUsed = ++this.historyClock;
    this.historyBytes += history.bytes;
    this.enforceHistoryBudget(canvasId);
  }
  private dropHistory(canvasId: string): void {
    const history = this.histories.get(canvasId);
    if (!history) return;
    this.historyBytes -= history.bytes;
    this.histories.delete(canvasId);
  }
  private enforceHistoryBudget(protectedCanvasId: string): void {
    while (this.historyBytes > DESIGN_HISTORY_MAX_BYTES) {
      let oldest: [string, DesignHistory] | undefined;
      for (const candidate of this.histories) {
        if (candidate[0] === protectedCanvasId) continue;
        if (!oldest || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
      }
      if (oldest) {
        this.dropHistory(oldest[0]);
        continue;
      }
      const history = this.histories.get(protectedCanvasId);
      if (!history) break;
      const removed = history.undo.shift() ?? history.redo.shift();
      if (!removed) break;
      history.bytes -= historyEntryBytes(removed);
      this.historyBytes -= historyEntryBytes(removed);
    }
  }
  private record(canvasId: string, entry: DesignHistoryEntry): void {
    const history = this.history(canvasId);
    history.undo.push(entry);
    if (history.undo.length > DESIGN_HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    this.refreshHistory(canvasId, history);
  }
  private status(canvasId: string, revision: number): DesignHistoryStatus {
    const history = this.histories.get(canvasId);
    const undoCount = history?.undo.length ?? 0;
    const redoCount = history?.redo.length ?? 0;
    return {
      revision,
      undoCount,
      redoCount,
      canUndo: undoCount > 0,
      canRedo: redoCount > 0,
    };
  }
  async historyStatus(canvasId: string, environmentId: string): Promise<DesignHistoryStatus> {
    return this.exclusive(async () => {
      await this.initialize();
      const id = designId.parse(canvasId);
      const metadata = this.metadata.get(id);
      if (!metadata || metadata.environmentId !== environmentId)
        throw new Error("Canvas not found in this environment");
      return this.status(id, metadata.revision);
    });
  }
  async getCanvasState(canvasId: string, environmentId: string): Promise<DesignCanvasState> {
    return this.exclusive(async () => {
      const canvas = await this.get(canvasId, environmentId);
      return { canvas, history: this.status(canvas.id, canvas.revision) };
    });
  }
  async create(
    environmentId: string,
    canvasName = "Untitled design",
    document?: string,
  ): Promise<DesignCanvas> {
    return this.exclusive(async () => {
      await this.initialize();
      if (this.metadata.size >= 256) throw new Error("Canvas limit reached (256)");
      if (document && Buffer.byteLength(document) > DESIGN_MAX_DOCUMENT_BYTES)
        throw new Error("Design file exceeds 4 MiB");
      const imported = document ? canvasSchema.parse(JSON.parse(document)) : undefined;
      const canvas: DesignCanvas = {
        format: "orkdes",
        version: 1,
        id: randomUUID(),
        environmentId,
        name: name.parse(imported?.name ?? canvasName),
        revision: 1,
        frames:
          imported?.frames.map((frame) => ({ ...frame, id: randomUUID(), revision: 1 })) ?? [],
      };
      await this.commit(canvas);
      return canvas;
    });
  }
  async delete(canvasId: string, environmentId: string): Promise<void> {
    await this.exclusive(async () => {
      const canvas = await this.get(canvasId, environmentId);
      await unlink(this.file(canvas.id));
      this.metadata.delete(canvas.id);
      this.dropHistory(canvas.id);
      for (let index = this.events.length - 1; index >= 0; index--) {
        if (this.events[index]?.canvasId === canvas.id) this.events.splice(index, 1);
      }
    });
  }
  async deleteEnvironment(environmentId: string): Promise<number> {
    return this.exclusive(async () => {
      await this.initialize();
      const ids = Array.from(this.metadata)
        .filter(([, metadata]) => metadata.environmentId === environmentId)
        .map(([id]) => id);
      for (const id of ids) {
        await unlink(this.file(id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        this.metadata.delete(id);
        this.dropHistory(id);
      }
      for (let index = this.events.length - 1; index >= 0; index--) {
        if (ids.includes(this.events[index]!.canvasId)) this.events.splice(index, 1);
      }
      return ids.length;
    });
  }
  private compare(expected: number, current: number) {
    revision.parse(expected);
    if (expected !== current)
      throw new Error(
        `${DESIGN_CONFLICT} expected ${expected}, current ${current}. Fetch the latest snapshot before editing.`,
      );
  }
  async createFrame(
    canvasId: string,
    environmentId: string,
    expectedRevision: number,
    input: Omit<DesignFrame, "id" | "revision">,
  ) {
    return this.exclusive(async () => {
      const canvas = await this.get(canvasId, environmentId);
      this.compare(expectedRevision, canvas.revision);
      if (canvas.frames.length >= DESIGN_MAX_FRAMES) throw new Error("Frame limit reached (64)");
      const frame = frameSchema.parse({
        name: input.name,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        html: input.html,
        id: randomUUID(),
        revision: 1,
      });
      canvas.frames.push(frame);
      canvas.revision++;
      await this.commit(canvas, frame.id, () =>
        this.record(canvas.id, {
          kind: "create-frame",
          index: canvas.frames.length - 1,
          after: copyFrame(frame),
        }),
      );
      return { frame, canvasRevision: canvas.revision };
    });
  }
  async getFrame(canvasId: string, environmentId: string, frameId: string) {
    const canvas = await this.get(canvasId, environmentId);
    const frame = canvas.frames.find((frame) => frame.id === frameId);
    if (!frame) throw new Error("Frame not found");
    return frame;
  }
  async mutate(
    canvasId: string,
    environmentId: string,
    frameId: string,
    expectedRevision: number,
    update:
      | Partial<Pick<DesignFrame, "name" | "x" | "y" | "width" | "height" | "html">>
      | DesignOperation,
  ) {
    return this.exclusive(async () => {
      const canvas = await this.get(canvasId, environmentId);
      const frame = canvas.frames.find((frame) => frame.id === frameId);
      if (!frame) throw new Error("Frame not found");
      this.compare(expectedRevision, frame.revision);
      const patch =
        "op" in update ? { html: (await this.renderer.run(frame, update)) as string } : update;
      const next = frameSchema.parse({
        ...frame,
        ...patch,
        id: frame.id,
        revision: frame.revision + 1,
      });
      canvas.frames[canvas.frames.indexOf(frame)] = next;
      canvas.revision++;
      const delta = frameDelta(frame, next);
      await this.commit(canvas, frame.id, () =>
        this.record(canvas.id, {
          kind: "update-frame",
          frameId: frame.id,
          ...delta,
        }),
      );
      return { frame: next, canvasRevision: canvas.revision };
    });
  }
  async undo(canvasId: string, environmentId: string, expectedRevision: number) {
    return this.restoreHistory(canvasId, environmentId, expectedRevision, "undo");
  }
  async redo(canvasId: string, environmentId: string, expectedRevision: number) {
    return this.restoreHistory(canvasId, environmentId, expectedRevision, "redo");
  }
  private async restoreHistory(
    canvasId: string,
    environmentId: string,
    expectedRevision: number,
    direction: "undo" | "redo",
  ) {
    return this.exclusive(async () => {
      const canvas = await this.get(canvasId, environmentId);
      this.compare(expectedRevision, canvas.revision);
      const history = this.history(canvas.id);
      const source = direction === "undo" ? history.undo : history.redo;
      const entry = source.at(-1);
      if (!entry) throw new Error(`Nothing to ${direction}`);

      let restoredEntry: DesignHistoryEntry;
      let frameId: string;
      if (entry.kind === "create-frame") {
        frameId = entry.after.id;
        if (direction === "undo") {
          const index = canvas.frames.findIndex((frame) => frame.id === frameId);
          if (index < 0) throw new Error("Design history is out of sync");
          const removed = copyFrame(canvas.frames[index]!);
          canvas.frames.splice(index, 1);
          restoredEntry = { ...entry, index, after: removed };
        } else {
          if (canvas.frames.some((frame) => frame.id === frameId))
            throw new Error("Design history is out of sync");
          if (canvas.frames.length >= DESIGN_MAX_FRAMES)
            throw new Error(`Frame limit reached (${DESIGN_MAX_FRAMES})`);
          const restored = copyFrame(entry.after);
          restored.revision++;
          canvas.frames.splice(Math.min(entry.index, canvas.frames.length), 0, restored);
          restoredEntry = { ...entry, after: copyFrame(restored) };
        }
      } else {
        frameId = entry.frameId;
        const index = canvas.frames.findIndex((frame) => frame.id === frameId);
        if (index < 0) throw new Error("Design history is out of sync");
        const current = canvas.frames[index]!;
        const target = direction === "undo" ? entry.before : entry.after;
        const restored = frameSchema.parse({
          ...current,
          ...target,
          id: current.id,
          revision: current.revision + 1,
        });
        canvas.frames[index] = restored;
        restoredEntry = entry;
      }

      canvas.revision++;
      const destination = direction === "undo" ? history.redo : history.undo;
      await this.commit(canvas, frameId, () => {
        source.pop();
        destination.push(restoredEntry);
        this.refreshHistory(canvas.id, history);
      });
      return { canvasRevision: canvas.revision, history: this.status(canvas.id, canvas.revision) };
    });
  }
  async changes(
    canvasId: string,
    environmentId: string,
    generation: string | undefined,
    after: number,
  ): Promise<DesignChanges> {
    await this.initialize();
    let metadata = this.metadata.get(designId.parse(canvasId));
    if (!metadata) {
      const canvas = await this.get(canvasId, environmentId);
      metadata = { environmentId: canvas.environmentId, revision: canvas.revision };
    }
    if (metadata.environmentId !== environmentId)
      throw new Error("Canvas not found in this environment");
    revision.parse(after);
    const events = this.events.filter(
      (event) => event.canvasId === canvasId && event.revision > after,
    );
    const reset =
      generation !== this.generation ||
      after > metadata.revision ||
      (after !== metadata.revision &&
        (events[0]?.revision !== after + 1 || events.at(-1)?.revision !== metadata.revision));
    return {
      generation: this.generation,
      revision: metadata.revision,
      reset,
      events: reset ? [] : events,
    };
  }
  async close() {
    await this.tail;
    await this.renderer.close();
  }
}
