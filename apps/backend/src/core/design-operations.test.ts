import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { DESIGN_MAX_CANVASES } from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
} from "@orkestrator/protocol/design-operations";
import { isDesignError } from "./design-errors.js";
import type { DesignService } from "./design-service.js";
import {
  createDesignHarness,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./design-test-support.js";

const frameInput = { name: "Home", x: 0, y: 0, width: 400, height: 300, html: "<h1>Hello</h1>" };

describe("design operations: prepare, execute, status and cancel", () => {
  let harness: DesignHarness;
  let clock: number;
  const faults: { beforeRename?: (file: string) => void; afterRename?: (file: string) => void } =
    {};
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;
  const serviceOptions = () => ({
    now: () => new Date(clock),
    faults: {
      beforeRename: (file: string) => faults.beforeRename?.(file),
      afterRename: (file: string) => faults.afterRename?.(file),
    },
  });

  beforeEach(async () => {
    rejections.install();
    clock = Date.parse("2026-09-24T10:00:00.000Z");
    delete faults.beforeRename;
    delete faults.afterRename;
    harness = await createDesignHarness({ prefix: "ork-design-ops-", service: serviceOptions() });
  });
  afterEach(async () => {
    delete faults.beforeRename;
    delete faults.afterRename;
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async (svc: DesignService = service(), environmentId = "env-1") => {
    const canvas = await svc.create(environmentId, "Operations", undefined, "user");
    const { frame } = await svc.createFrame(canvas.id, environmentId, 1, frameInput, "user");
    return { canvasId: canvas.id, frameId: frame.id };
  };
  const move = (
    canvasId: string,
    frameId: string,
    frameRevision: number,
    x: number,
  ): DesignOperationDescriptor => ({
    canvasId,
    input: { kind: "update_frame", frameId, patch: { x } },
    preconditions: { frameRevision },
  });
  const style = (
    canvasId: string,
    frameId: string,
    frameRevision: number,
    color: string,
  ): DesignOperationDescriptor => ({
    canvasId,
    input: { kind: "set_element_styles", frameId, selector: "h1", styles: { color } },
    preconditions: { frameRevision },
  });
  /** Arms a one-shot fault on the next write of this canvas's private record. */
  const armRecordFault = (hook: "beforeRename" | "afterRename", canvasId: string) => {
    faults[hook] = (file) => {
      if (!file.endsWith(`${canvasId}.orkrec`)) return;
      delete faults[hook];
      throw new Error(`injected ${hook} crash`);
    };
  };
  const readRecordFile = async (canvasId: string) =>
    JSON.parse(await readFile(service().store.recordFile(canvasId), "utf8")) as {
      document: { revision: number; frames: Array<{ x: number; html: string }> };
      receipts: DesignOperationStatus[];
    };

  test("prepare stores intent without editing; execute commits once; status is side-effect free", async () => {
    const { canvasId, frameId } = await setup();
    const before = await service().get(canvasId, "env-1");
    const prepared = await service().prepare("env-1", "user", move(canvasId, frameId, 1, 40));
    expect(prepared).toMatchObject({ canvasId, state: "prepared" });
    expect(await service().get(canvasId, "env-1")).toEqual(before);
    const jobs = harness.renderer.jobs.length;
    const events = harness.events.length;
    expect(await service().status("env-1", canvasId, prepared.token)).toMatchObject({
      state: "prepared",
      kind: "update_frame",
    });
    expect(harness.renderer.jobs.length).toBe(jobs);
    expect(harness.events.length).toBe(events);
    const committed = await service().execute("env-1", canvasId, prepared.token);
    expect(committed).toMatchObject({
      state: "committed",
      result: { canvasRevision: 3, frames: [{ frameId, revision: 2 }] },
    });
    expect(harness.events.length).toBe(events + 1);
    expect(await service().status("env-1", canvasId, prepared.token)).toEqual(committed);
  });

  test("a lost execute response is answered by status and a repeated execute changes nothing", async () => {
    const { canvasId, frameId } = await setup();
    const prepared = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "append_frame_html", frameId, html: "<p>once</p>" },
      preconditions: { frameRevision: 1 },
    });
    const first = await service().execute("env-1", canvasId, prepared.token);
    expect(first.state).toBe("committed");
    const afterFirst = await service().get(canvasId, "env-1");
    const events = harness.events.length;
    const jobs = harness.renderer.jobs.length;
    // The client never saw `first`: it asks, then retries execute.
    expect(await service().status("env-1", canvasId, prepared.token)).toEqual(first);
    expect(await service().execute("env-1", canvasId, prepared.token)).toEqual(first);
    expect(await service().get(canvasId, "env-1")).toEqual(afterFirst);
    expect(afterFirst.frames[0]!.html.match(/once/g)).toHaveLength(1);
    expect(harness.events.length).toBe(events);
    expect(harness.renderer.jobs.length).toBe(jobs);
    // Also across restart.
    const restarted = await harness.restart(serviceOptions());
    expect(await restarted.execute("env-1", canvasId, prepared.token)).toEqual(first);
    expect(await restarted.get(canvasId, "env-1")).toEqual(afterFirst);
  });

  test("concurrent executes of one token share one run", async () => {
    const { canvasId, frameId } = await setup();
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "applyStyles" ? gate.promise : undefined;
    const prepared = await service().prepare("env-1", "user", style(canvasId, frameId, 1, "red"));
    const first = service().execute("env-1", canvasId, prepared.token);
    await harness.renderer.started((job) => job.op === "applyStyles");
    const second = service().execute("env-1", canvasId, prepared.token);
    expect(await service().status("env-1", canvasId, prepared.token)).toMatchObject({
      state: "executing",
    });
    await expect(service().cancel("env-1", canvasId, prepared.token)).rejects.toThrow(
      "already started",
    );
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.state).toBe("committed");
    expect(harness.renderer.jobs.filter((job) => job.op === "applyStyles")).toHaveLength(1);
  });

  test("changed input, another environment or another canvas cannot execute a token", async () => {
    const { canvasId, frameId } = await setup();
    const other = await setup();
    await service().create("env-2", "Elsewhere");
    const prepared = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 1, 10),
      correlationId: "corr-1",
    });
    // Same correlation id with different input is refused at preparation.
    await expect(
      service().prepare("env-1", "user", {
        ...move(canvasId, frameId, 1, 99),
        correlationId: "corr-1",
      }),
    ).rejects.toThrow("different edit");
    // The same correlation id and digest reconciles to the same token.
    expect(
      (
        await service().prepare("env-1", "user", {
          ...move(canvasId, frameId, 1, 10),
          correlationId: "corr-1",
        })
      ).token,
    ).toBe(prepared.token);
    await expect(service().execute("env-2", canvasId, prepared.token)).rejects.toThrow("not found");
    expect(await service().execute("env-1", other.canvasId, prepared.token)).toMatchObject({
      state: "unknown",
      failure: { code: "expired-operation" },
    });
    // Tampering with the stored descriptor breaks its digest binding.
    const pendingFile = service().store.pendingFile(canvasId);
    const pending = JSON.parse(await readFile(pendingFile, "utf8")) as Array<{
      descriptor: DesignOperationDescriptor;
    }>;
    pending[0]!.descriptor = move(canvasId, frameId, 1, 555);
    await writeFile(pendingFile, JSON.stringify(pending));
    expect(await service().execute("env-1", canvasId, prepared.token)).toMatchObject({
      state: "expired",
      failure: { code: "expired-operation" },
    });
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
    expect((await service().getFrame(other.canvasId, "env-1", other.frameId)).x).toBe(0);
  });

  test("unknown and expired tokens never execute, even after their receipt is pruned", async () => {
    const { canvasId, frameId } = await setup();
    const unknown = `op_${crypto.randomUUID()}`;
    expect(await service().execute("env-1", canvasId, unknown)).toMatchObject({
      state: "unknown",
      failure: { code: "expired-operation" },
    });
    await expect(service().execute("env-1", canvasId, "not-a-token")).rejects.toThrow();
    const prepared = await service().prepare("env-1", "user", move(canvasId, frameId, 1, 10));
    clock += DESIGN_LIMITS.preparedTtlMs + 1;
    const expired = await service().execute("env-1", canvasId, prepared.token);
    expect(expired).toMatchObject({ state: "expired", failure: { code: "expired-operation" } });
    expect(await service().execute("env-1", canvasId, prepared.token)).toEqual(expired);
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
    // Push the expired receipt out of the bounded receipt list.
    for (let index = 1; index <= DESIGN_LIMITS.receiptsPerCanvas + 1; index++)
      await service().mutate(canvasId, "env-1", frameId, index, { y: index }, "user");
    const record = await readRecordFile(canvasId);
    expect(record.receipts.some((receipt) => receipt.token === prepared.token)).toBe(false);
    expect(await service().execute("env-1", canvasId, prepared.token)).toMatchObject({
      state: "unknown",
    });
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
  });

  test("cancel settles prepared work before execution and a lost prepare response runs nothing", async () => {
    const { canvasId, frameId } = await setup();
    const canceled = await service().prepare("env-1", "user", move(canvasId, frameId, 1, 10));
    expect(await service().cancel("env-1", canvasId, canceled.token)).toMatchObject({
      state: "canceled",
    });
    expect(await service().execute("env-1", canvasId, canceled.token)).toMatchObject({
      state: "canceled",
    });
    // Preparation whose response was lost: nothing ever executes it.
    const lost = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 1, 20),
      correlationId: "lost-prepare",
    });
    const reconciled = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 1, 20),
      correlationId: "lost-prepare",
    });
    expect(reconciled.token).toBe(lost.token);
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
    expect(await service().status("env-1", canvasId, lost.token)).toMatchObject({
      state: "prepared",
    });
    clock += DESIGN_LIMITS.preparedTtlMs + 1;
    expect((await service().execute("env-1", canvasId, lost.token)).state).toBe("expired");
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
  });

  test("restart turns prepared and executing work into interrupted receipts that never run", async () => {
    const { canvasId, frameId } = await setup();
    const prepared = await service().prepare("env-1", "user", move(canvasId, frameId, 1, 10));
    const executing = await service().prepare("env-1", "user", style(canvasId, frameId, 1, "blue"));
    // The process dies inside the commit of `executing`, before the atomic rename.
    armRecordFault("beforeRename", canvasId);
    await expect(service().execute("env-1", canvasId, executing.token)).rejects.toThrow("injected");
    // A failed commit is reported as an unknown outcome, never as still executing.
    expect(await service().status("env-1", canvasId, executing.token)).toMatchObject({
      state: "unknown",
      failure: { code: "unknown-outcome" },
    });
    const restarted = await harness.restart(serviceOptions());
    const jobs = harness.renderer.jobs.length;
    for (const token of [prepared.token, executing.token]) {
      const status = await restarted.status("env-1", canvasId, token);
      expect(status).toMatchObject({ state: "interrupted", failure: { code: "unknown-outcome" } });
      expect(await restarted.execute("env-1", canvasId, token)).toEqual(status);
    }
    expect(harness.renderer.jobs.length).toBe(jobs);
    const current = await restarted.getFrame(canvasId, "env-1", frameId);
    expect(current).toMatchObject({ x: 0, revision: 1, html: frameInput.html });
  });

  test("a crash before the atomic rename keeps the old document and no committed receipt", async () => {
    const { canvasId, frameId } = await setup();
    const prepared = await service().prepare("env-1", "user", move(canvasId, frameId, 1, 70));
    const events = harness.events.length;
    armRecordFault("beforeRename", canvasId);
    await expect(service().execute("env-1", canvasId, prepared.token)).rejects.toThrow("injected");
    expect(harness.events.length).toBe(events);
    const onDisk = await readRecordFile(canvasId);
    expect(onDisk.document.frames[0]!.x).toBe(0);
    expect(onDisk.receipts.some((receipt) => receipt.token === prepared.token)).toBe(false);
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
    const restarted = await harness.restart(serviceOptions());
    expect((await restarted.getFrame(canvasId, "env-1", frameId)).x).toBe(0);
    expect((await restarted.status("env-1", canvasId, prepared.token)).state).toBe("interrupted");
  });

  test("a crash after the rename leaves document and receipt agreeing; sync repairs the missed hint", async () => {
    const { canvasId, frameId } = await setup();
    const clientGeneration = service().generation;
    const prepared = await service().prepare("env-1", "user", move(canvasId, frameId, 1, 70));
    const events = harness.events.length;
    armRecordFault("afterRename", canvasId);
    await expect(service().execute("env-1", canvasId, prepared.token)).rejects.toThrow("injected");
    expect(harness.events.length).toBe(events);
    // In-process reads never serve the pre-crash cached copy.
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(70);
    expect(await service().status("env-1", canvasId, prepared.token)).toMatchObject({
      state: "committed",
      result: { canvasRevision: 3 },
    });
    expect(await service().sync("env-1", canvasId, clientGeneration, 2, 0)).toMatchObject({
      kind: "delta",
      baseRevision: 2,
      revision: 3,
      patched: [{ id: frameId, x: 70 }],
    });
    const restarted = await harness.restart(serviceOptions());
    const snapshot = await restarted.snapshot("env-1", canvasId);
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      canvas: { revision: 3, frames: [{ x: 70 }] },
    });
    expect(await restarted.status("env-1", canvasId, prepared.token)).toMatchObject({
      state: "committed",
      result: { canvasRevision: 3 },
    });
    expect(await restarted.execute("env-1", canvasId, prepared.token)).toMatchObject({
      state: "committed",
    });
    expect((await restarted.get(canvasId, "env-1")).revision).toBe(3);
    // A client from the old generation is told to reset, then reads the same state.
    expect(await restarted.sync("env-1", canvasId, clientGeneration, 2, 0)).toMatchObject({
      kind: "reset",
      reason: "generation",
      revision: 3,
    });
  });

  test("concurrent creates at the quota reserve capacity exactly, also after restart", async () => {
    for (let index = 0; index < DESIGN_MAX_CANVASES - 2; index++)
      await service().create("env-1", `Canvas ${index}`);
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        service().prepare("env-1", "user", {
          input: { kind: "create_canvas", name: `Race ${index}` },
        }),
      ),
    );
    const admitted = attempts.filter((result) => result.status === "fulfilled");
    expect(admitted).toHaveLength(2);
    for (const result of attempts)
      if (result.status === "rejected") expect(isDesignError(result.reason, "capacity")).toBe(true);
    // Reservations count even before execution.
    await expect(service().create("env-1", "Over")).rejects.toThrow("Canvas limit");
    const restarted = await harness.restart(serviceOptions());
    // Reservations from the previous process are released and can never execute.
    for (const result of admitted) {
      const reservation = (result as PromiseFulfilledResult<{ token: string; canvasId: string }>)
        .value;
      await expect(
        restarted.execute("env-1", reservation.canvasId, reservation.token),
      ).rejects.toThrow();
      expect(await restarted.snapshot("env-1", reservation.canvasId)).toMatchObject({
        kind: "missing",
      });
    }
    const after = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) => restarted.create("env-1", `After ${index}`)),
    );
    expect(after.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect((await restarted.list("env-1")).length).toBe(DESIGN_MAX_CANVASES);
  }, 60_000);

  test("a create token executes once and a retry returns the same canvas", async () => {
    const prepared = await service().prepare("env-1", "user", {
      input: { kind: "create_canvas", name: "Once" },
    });
    expect(await service().snapshot("env-1", prepared.canvasId)).toMatchObject({ kind: "missing" });
    const first = await service().execute("env-1", prepared.canvasId, prepared.token);
    const second = await service().execute("env-1", prepared.canvasId, prepared.token);
    expect(first).toMatchObject({
      state: "committed",
      result: { createdCanvasId: prepared.canvasId },
    });
    expect(second).toEqual(first);
    expect(await service().list("env-1")).toEqual([
      { id: prepared.canvasId, name: "Once", revision: 1 },
    ]);
  });

  test("a create prepared twice with one correlation id reserves one canvas", async () => {
    const descriptor: DesignOperationDescriptor = {
      input: { kind: "create_canvas", name: "Correlated" },
      preconditions: {},
      correlationId: "create-once",
    };
    const [a, b] = await Promise.all([
      service().prepare("env-1", "user", descriptor),
      service().prepare("env-1", "user", descriptor),
    ]);
    expect(b).toEqual(a);
    await expect(
      service().prepare("env-1", "user", {
        ...descriptor,
        input: { kind: "create_canvas", name: "Different" },
      }),
    ).rejects.toThrow("different edit");
    // Another environment has its own correlation namespace.
    const elsewhere = await service().prepare("env-2", "user", descriptor);
    expect(elsewhere.canvasId).not.toBe(a.canvasId);
    expect((await service().execute("env-1", a.canvasId, a.token)).state).toBe("committed");
    await expect(service().prepare("env-1", "user", descriptor)).rejects.toThrow("settled");
    expect(await service().list("env-1")).toHaveLength(1);
  });

  test("predecessor substitution only chains a committed predecessor from the same client", async () => {
    const { canvasId, frameId } = await setup();
    const first = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 1, 10),
      clientId: "client-a",
    });
    expect((await service().execute("env-1", canvasId, first.token)).state).toBe("committed");
    // Same client, declared base 1 is stale but its own committed predecessor produced revision 2.
    const chained = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 1, 20),
      clientId: "client-a",
      predecessor: first.token,
    });
    expect(await service().execute("env-1", canvasId, chained.token)).toMatchObject({
      state: "committed",
      result: { frames: [{ frameId, revision: 3 }] },
    });
    // A later chain from the old base no longer matches the predecessor's result.
    const stale = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 1, 30),
      clientId: "client-a",
      predecessor: first.token,
    });
    expect(await service().execute("env-1", canvasId, stale.token)).toMatchObject({
      state: "rejected",
      failure: { code: "conflict" },
    });
    // Another client (same actor) cannot borrow client-a's predecessor.
    const second = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 3, 40),
      clientId: "client-a",
    });
    expect((await service().execute("env-1", canvasId, second.token)).state).toBe("committed");
    const foreign = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 3, 50),
      clientId: "client-b",
      predecessor: second.token,
    });
    expect((await service().execute("env-1", canvasId, foreign.token)).failure?.code).toBe(
      "conflict",
    );
    // Nor can the agent, nor a request without a client id.
    const agent = await service().prepare("env-1", "agent", {
      ...move(canvasId, frameId, 3, 60),
      clientId: "client-a",
      predecessor: second.token,
    });
    expect((await service().execute("env-1", canvasId, agent.token)).failure?.code).toBe(
      "conflict",
    );
    const anonymous = await service().prepare("env-1", "user", {
      ...move(canvasId, frameId, 3, 70),
      predecessor: second.token,
    });
    expect((await service().execute("env-1", canvasId, anonymous.token)).failure?.code).toBe(
      "conflict",
    );
    // Structural operations never chain.
    const structural = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "replace_frame_html", frameId, html: "<p>x</p>" },
      preconditions: { frameRevision: 3 },
      clientId: "client-a",
      predecessor: second.token,
    });
    expect((await service().execute("env-1", canvasId, structural.token)).failure?.code).toBe(
      "conflict",
    );
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(40);
  });

  test("two edits rendering from the same base: one commit, one conflict, both receipts kept", async () => {
    const { canvasId, frameId } = await setup();
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "applyStyles" ? gate.promise : undefined;
    const red = await service().prepare("env-1", "user", style(canvasId, frameId, 1, "red"));
    const blue = await service().prepare("env-1", "agent", style(canvasId, frameId, 1, "blue"));
    const executions = [
      service().execute("env-1", canvasId, red.token),
      service().execute("env-1", canvasId, blue.token),
    ];
    await harness.renderer.started((job) => job.op === "applyStyles", 2);
    gate.resolve();
    const results = await Promise.all(executions);
    expect(results.map((result) => result.state).sort()).toEqual(["committed", "rejected"]);
    const loser = results.find((result) => result.state === "rejected")!;
    expect(loser.failure).toMatchObject({
      code: "conflict",
      revisions: { expected: 1, current: 2 },
    });
    const winner = results.find((result) => result.state === "committed")!;
    const record = await readRecordFile(canvasId);
    expect(record.receipts.map((receipt) => receipt.token)).toEqual(
      expect.arrayContaining([red.token, blue.token]),
    );
    const html = (await service().getFrame(canvasId, "env-1", frameId)).html;
    expect(html).toContain(winner.token === red.token ? "red" : "blue");
    expect(html).not.toContain(winner.token === red.token ? "blue" : "red");
  });

  test("a blocked render on one canvas never blocks geometry or status elsewhere", async () => {
    const a = await setup();
    const b = await setup();
    const secondOnA = await service().createFrame(
      a.canvasId,
      "env-1",
      2,
      { ...frameInput, name: "Second" },
      "user",
    );
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.canvasId === a.canvasId && job.operation.op === "applyStyles" ? gate.promise : undefined;
    try {
      const pending = await service().prepare(
        "env-1",
        "user",
        style(a.canvasId, a.frameId, 1, "green"),
      );
      const running = service().execute("env-1", a.canvasId, pending.token);
      await harness.renderer.started(
        (job) => job.canvasId === a.canvasId && job.op === "applyStyles",
      );
      await expect(
        service().mutate(b.canvasId, "env-1", b.frameId, 1, { x: 5 }, "user"),
      ).resolves.toBeDefined();
      // Even geometry on another frame of the same canvas commits: no lane is held while rendering.
      await expect(
        service().mutate(a.canvasId, "env-1", secondOnA.frame.id, 1, { x: 9 }, "user"),
      ).resolves.toBeDefined();
      expect(await service().status("env-1", a.canvasId, pending.token)).toMatchObject({
        state: "executing",
      });
      expect(await service().snapshot("env-1", a.canvasId)).toMatchObject({ kind: "snapshot" });
      gate.resolve();
      expect(await running).toMatchObject({ state: "committed" });
    } finally {
      gate.resolve();
    }
    expect((await service().getFrame(a.canvasId, "env-1", secondOnA.frame.id)).x).toBe(9);
    expect((await service().getFrame(a.canvasId, "env-1", a.frameId)).html).toContain("green");
  });

  test("execute answers `executing` after its wait budget and the work finishes in the backend", async () => {
    const { canvasId, frameId } = await setup();
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "applyStyles" ? gate.promise : undefined;
    const prepared = await service().prepare(
      "env-1",
      "user",
      style(canvasId, frameId, 1, "purple"),
    );
    const answer = await service().execute("env-1", canvasId, prepared.token, { waitMs: 0 });
    expect(answer.state).toBe("executing");
    gate.resolve();
    // A later execute joins the backend-owned run instead of starting another.
    expect(await service().execute("env-1", canvasId, prepared.token)).toMatchObject({
      state: "committed",
    });
    expect(harness.renderer.jobs.filter((job) => job.op === "applyStyles")).toHaveLength(1);
  });
});
