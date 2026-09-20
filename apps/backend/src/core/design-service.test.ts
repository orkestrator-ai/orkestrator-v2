import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESIGN_MAX_HTML_BYTES } from "@orkestrator/protocol/design-canvas";
import { DesignService } from "./design-service.js";
import { runDesignAction } from "./design-tools.js";

describe("backend design canvases", () => {
  let dir: string, service: DesignService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ork-design-test-"));
    service = new DesignService(dir, () => {});
  });
  afterEach(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const frame = { name: "Home", x: 0, y: 0, width: 800, height: 600, html: "<h1>Hello</h1>" };

  test("persists documents across service restarts and isolates environments", async () => {
    const canvas = await service.create("env-1", "Product");
    const created = await service.createFrame(canvas.id, "env-1", 1, frame);
    const restarted = new DesignService(dir, () => {});
    expect((await restarted.get(canvas.id, "env-1")).frames).toEqual([created.frame]);
    expect(await restarted.list("env-1")).toEqual([
      { id: canvas.id, name: "Product", revision: 2 },
    ]);
    expect(await restarted.list("env-2")).toEqual([]);
    await expect(restarted.get(canvas.id, "env-2")).rejects.toThrow("not found");
    await expect(restarted.get("../../outside")).rejects.toThrow();
  });
  test("only one concurrent human/agent mutation can win the same revision", async () => {
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    const results = await Promise.allSettled([
      service.mutate(canvas.id, "env-1", created.id, 1, { html: "<p>Human</p>" }),
      service.mutate(canvas.id, "env-1", created.id, 1, { html: "<p>Agent</p>" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toContain(
      "Design revision conflict:",
    );
    expect((await service.getFrame(canvas.id, "env-1", created.id)).html).toBe("<p>Human</p>");
    await expect(service.createFrame(canvas.id, "env-1", 1, frame)).rejects.toThrow(
      "Design revision conflict:",
    );
  });
  test("missed events, expired replay, and generation changes recover from snapshots", async () => {
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    expect(await service.changes(canvas.id, "env-1", service.generation, 1)).toMatchObject({
      reset: false,
      revision: 2,
      events: [{ revision: 2 }],
    });
    // No client is subscribed while the backend keeps working.
    for (let i = 1; i <= 260; i++)
      await service.mutate(canvas.id, "env-1", created.id, i, { x: i });
    expect(await service.changes(canvas.id, "env-1", service.generation, 1)).toMatchObject({
      reset: true,
      events: [],
      revision: 262,
    });
    const restarted = new DesignService(dir, () => {});
    expect(await restarted.changes(canvas.id, "env-1", service.generation, 262)).toMatchObject({
      reset: true,
    });
    expect((await restarted.get(canvas.id)).frames[0]?.x).toBe(260);
  });
  test("imports portable documents under fresh identities and rejects oversized input", async () => {
    const original = await service.create("env-1", "Portable");
    await service.createFrame(original.id, "env-1", 1, frame);
    const imported = await service.create(
      "env-2",
      "unused",
      JSON.stringify(await service.get(original.id)),
    );
    expect(imported.id).not.toBe(original.id);
    expect(imported.environmentId).toBe("env-2");
    expect(imported.frames[0]?.html).toBe(frame.html);
    await expect(
      service.createFrame(original.id, "env-1", 2, {
        ...frame,
        html: "x".repeat(DESIGN_MAX_HTML_BYTES + 1),
      }),
    ).rejects.toThrow();
    expect((await service.get(original.id)).revision).toBe(2);
  });
  test("UI and MCP share validation, including frame creation and required CAS", async () => {
    const canvas = await service.create("env-1");
    const created = (await runDesignAction(service, "env-1", "create_frame", {
      canvasId: canvas.id,
      expectedRevision: 1,
      ...frame,
    })) as { frame: { id: string } };
    await expect(
      runDesignAction(service, "env-1", "replace_frame_html", {
        canvasId: canvas.id,
        frameId: created.frame.id,
        html: "wrong",
      }),
    ).rejects.toThrow();
    await expect(
      runDesignAction(service, "env-2", "get_frame", {
        canvasId: canvas.id,
        frameId: created.frame.id,
      }),
    ).rejects.toThrow("not found");
  });
});
