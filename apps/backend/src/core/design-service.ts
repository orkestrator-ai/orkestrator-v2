import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DESIGN_CONFLICT,
  DESIGN_EVENT,
  DESIGN_MAX_DOCUMENT_BYTES,
  DESIGN_MAX_FRAMES,
  DESIGN_MAX_HTML_BYTES,
  type DesignCanvas,
  type DesignChange,
  type DesignChanges,
  type DesignFrame,
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

export class DesignService {
  readonly generation = randomUUID();
  private readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly events: DesignChange[] = [];
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
  async get(id: string, environmentId?: string): Promise<DesignCanvas> {
    const handle = await open(this.file(id), "r");
    try {
      const stat = await handle.stat();
      if (stat.size > DESIGN_MAX_DOCUMENT_BYTES) throw new Error("Design file exceeds 4 MiB");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > stat.size) throw new Error("Design file changed during read");
      const canvas = canvasSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      if (canvas.id !== id || (environmentId && canvas.environmentId !== environmentId))
        throw new Error("Canvas not found in this environment");
      return canvas;
    } finally {
      await handle.close();
    }
  }
  async list(environmentId: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.root))
      .filter((file) => file.endsWith(".orkdes"))
      .slice(0, 256);
    const result: Array<{ id: string; name: string; revision: number }> = [];
    for (const file of files) {
      const canvas = await this.get(file.slice(0, -7));
      if (canvas.environmentId === environmentId)
        result.push({ id: canvas.id, name: canvas.name, revision: canvas.revision });
    }
    return result;
  }
  private async commit(canvas: DesignCanvas, frameId?: string) {
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
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    const event: DesignChange = {
      canvasId: canvas.id,
      revision: canvas.revision,
      ...(frameId ? { frameId } : {}),
    };
    this.events.push(event);
    if (this.events.length > 256) this.events.shift();
    // Content-free bounded hints; clients read snapshots and detect gaps.
    this.emit(DESIGN_EVENT, { ...event, generation: this.generation });
  }
  async create(
    environmentId: string,
    canvasName = "Untitled design",
    document?: string,
  ): Promise<DesignCanvas> {
    return this.exclusive(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await readdir(this.root)).filter((file) => file.endsWith(".orkdes")).length >= 256)
        throw new Error("Canvas limit reached (256)");
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
      await this.commit(canvas, frame.id);
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
      await this.commit(canvas, frame.id);
      return { frame: next, canvasRevision: canvas.revision };
    });
  }
  async changes(
    canvasId: string,
    environmentId: string,
    generation: string | undefined,
    after: number,
  ): Promise<DesignChanges> {
    const canvas = await this.get(canvasId, environmentId);
    revision.parse(after);
    const events = this.events.filter(
      (event) => event.canvasId === canvasId && event.revision > after,
    );
    const reset =
      generation !== this.generation ||
      after > canvas.revision ||
      (after !== canvas.revision &&
        (events[0]?.revision !== after + 1 || events.at(-1)?.revision !== canvas.revision));
    return {
      generation: this.generation,
      revision: canvas.revision,
      reset,
      events: reset ? [] : events,
    };
  }
  async close() {
    await this.tail;
    await this.renderer.close();
  }
}
