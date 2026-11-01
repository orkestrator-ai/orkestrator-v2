import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DESIGN_INTENT_LIMITS,
  type DesignIntentDraft,
  type DesignStoredIntent,
} from "@orkestrator/protocol/design-operations";
import {
  discardIntent,
  importIntents,
  listIntents,
  readIntents,
  resumeIntent,
  runIntent,
  saveIntentDrafts,
} from "./intents.js";
import {
  createDesignHarness,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./test-support.js";

const frameInput = { name: "Home", x: 0, y: 0, width: 400, height: 300, html: "<h1>Hello</h1>" };

describe("design intents: the backend-owned edit queue", () => {
  let harness: DesignHarness;
  let clock: number;
  let sequence = 0;
  const rejections = trackUnhandledRejections();
  const options = () => ({ now: () => new Date(clock) });
  const service = () => harness.service;

  beforeEach(async () => {
    rejections.install();
    clock = Date.parse("2026-11-01T10:00:00.000Z");
    harness = await createDesignHarness({ prefix: "ork-design-intents-", service: options() });
  });
  afterEach(async () => {
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async () => {
    const canvas = await service().create("env-1", "Intents", undefined, "user");
    const { frame } = await service().createFrame(canvas.id, "env-1", 1, frameInput, "user");
    return { canvasId: canvas.id, frameId: frame.id };
  };
  const move = (
    canvasId: string,
    frameId: string,
    frameRevision: number,
    x: number,
    clientId = "client-a",
  ): DesignIntentDraft => {
    const id = `i-${++sequence}`;
    return {
      id,
      lane: frameId,
      label: `Move ${x}`,
      createdAt: clock,
      descriptor: {
        canvasId,
        input: { kind: "update_frame", frameId, patch: { x } },
        preconditions: { frameRevision },
        clientId,
        correlationId: id,
      },
      preview: { frameId, patch: { x } },
    };
  };
  const list = async (canvasId: string) =>
    (await listIntents(service(), "env-1", canvasId)).intents;
  const byId = async (canvasId: string, id: string) =>
    (await list(canvasId)).find((intent) => intent.id === id);

  test("a run commits, publishes an intents hint and keeps the success only briefly", async () => {
    const { canvasId, frameId } = await setup();
    const draft = move(canvasId, frameId, 1, 10);
    const run = await runIntent(service(), "env-1", canvasId, draft, 5000);
    expect(run.status?.state).toBe("committed");
    expect(run.intent).toMatchObject({
      phase: "settled",
      outcome: "committed",
      token: run.status!.token,
    });
    expect(
      harness.events.some((event) => event.intents === true && event.canvasId === canvasId),
    ).toBe(true);
    expect((await byId(canvasId, draft.id))?.outcome).toBe("committed");
    clock += DESIGN_INTENT_LIMITS.settledRetentionMs;
    expect(await list(canvasId)).toEqual([]);
  });

  test("a client's queued edit is rebased over its own commit, never over another writer's", async () => {
    const { canvasId, frameId } = await setup();
    await runIntent(service(), "env-1", canvasId, move(canvasId, frameId, 1, 10), 5000);
    // Observed revision 1 before the first edit committed: its own chain proves revision 2.
    const second = await runIntent(
      service(),
      "env-1",
      canvasId,
      move(canvasId, frameId, 1, 20),
      5000,
    );
    expect(second.status).toMatchObject({ state: "committed", base: { frameRevision: 2 } });
    // Another client cannot borrow client-a's chain.
    const foreign = move(canvasId, frameId, 1, 30, "client-b");
    const rejected = await runIntent(service(), "env-1", canvasId, foreign, 5000);
    expect(rejected.status?.failure?.code).toBe("conflict");
    expect(await byId(canvasId, foreign.id)).toMatchObject({
      phase: "settled",
      outcome: "rejected",
      clientId: "client-b",
    });
    // An agent edit in between breaks client-a's chain: the conflict surfaces.
    await service().runOnce("env-1", "agent", {
      canvasId,
      input: { kind: "update_frame", frameId, patch: { x: 99 } },
      preconditions: { frameRevision: 3 },
    });
    const broken = await runIntent(
      service(),
      "env-1",
      canvasId,
      move(canvasId, frameId, 2, 40),
      5000,
    );
    expect(broken.status?.failure?.code).toBe("conflict");
  });

  test("any client sees a rejected edit, resumes it with a reviewed base, and runs it", async () => {
    const { canvasId, frameId } = await setup();
    const stale = move(canvasId, frameId, 7, 10);
    expect((await runIntent(service(), "env-1", canvasId, stale, 5000)).status?.state).toBe(
      "rejected",
    );
    const resumed = await resumeIntent(service(), "env-1", canvasId, stale.id, "client-b", {
      frameRevision: 1,
    });
    expect(resumed.intent).toMatchObject({ phase: "draft", clientId: "client-b" });
    expect(resumed.intent?.token).toBeUndefined();
    expect(resumed.intent?.descriptor.correlationId).not.toBe(stale.id);
    // The original client no longer owns it.
    await expect(runIntent(service(), "env-1", canvasId, stale, 5000)).rejects.toMatchObject({
      failure: { code: "conflict" },
    });
    const intent = resumed.intent!;
    const rerun = await runIntent(
      service(),
      "env-1",
      canvasId,
      {
        id: intent.id,
        lane: intent.lane,
        label: intent.label,
        createdAt: intent.createdAt,
        descriptor: intent.descriptor,
      },
      5000,
    );
    expect(rerun.status?.state).toBe("committed");
  });

  test("an edit the backend refuses stays listed for review", async () => {
    const { canvasId, frameId } = await setup();
    const bad: DesignIntentDraft = {
      ...move(canvasId, frameId, 1, 10),
      descriptor: {
        canvasId,
        input: { kind: "rename_canvas", name: "x" },
        preconditions: {},
        clientId: "client-a",
        correlationId: "i-rename",
      },
      id: "i-rename",
    };
    const refused = await runIntent(service(), "env-1", canvasId, bad, 5000);
    expect(refused.status?.state).toBe("rejected");
    expect(refused.status?.failure?.code).toBe("invalid-input");
  });

  test("drafts are saved per client, never overwrite sent edits, and are bounded", async () => {
    const { canvasId, frameId } = await setup();
    const mine = move(canvasId, frameId, 1, 10);
    const theirs = move(canvasId, frameId, 1, 20, "client-b");
    await saveIntentDrafts(service(), "env-1", canvasId, "client-a", [mine]);
    await saveIntentDrafts(service(), "env-1", canvasId, "client-b", [theirs]);
    // A later save of one client's drafts leaves the other's alone.
    await saveIntentDrafts(service(), "env-1", canvasId, "client-a", [
      { ...mine, label: "Moved again" },
    ]);
    expect((await list(canvasId)).map((intent) => [intent.id, intent.label, intent.phase])).toEqual(
      [
        [mine.id, "Moved again", "draft"],
        [theirs.id, "Move 20", "draft"],
      ],
    );
    // Saving a draft another client owns is ignored.
    await saveIntentDrafts(service(), "env-1", canvasId, "client-a", [{ ...theirs, label: "x" }]);
    expect((await byId(canvasId, theirs.id))?.label).toBe("Move 20");
    const many = Array.from({ length: DESIGN_INTENT_LIMITS.perClient }, (_, index) =>
      move(canvasId, frameId, 1, 100 + index),
    );
    await expect(
      saveIntentDrafts(service(), "env-1", canvasId, "client-a", many),
    ).rejects.toMatchObject({ failure: { code: "capacity" } });
    // Another environment cannot read or write this queue.
    await expect(listIntents(service(), "env-2", canvasId)).rejects.toMatchObject({
      failure: { code: "not-found" },
    });
  });

  test("discard cancels a token that has not started and removes the edit for everyone", async () => {
    const { canvasId, frameId } = await setup();
    const prepared = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "update_frame", frameId, patch: { x: 5 } },
      preconditions: { frameRevision: 1 },
      clientId: "client-a",
      correlationId: "i-legacy",
    });
    await importIntents(service(), "env-1", canvasId, "client-a", [
      {
        id: "i-legacy",
        lane: frameId,
        label: "Move",
        createdAt: clock,
        descriptor: {
          canvasId,
          input: { kind: "update_frame", frameId, patch: { x: 5 } },
          preconditions: { frameRevision: 1 },
          clientId: "client-a",
          correlationId: "i-legacy",
        },
        phase: "prepared",
        token: prepared.token,
      },
    ]);
    expect(await discardIntent(service(), "env-1", canvasId, "i-legacy")).toEqual({
      discarded: true,
      mayStillFinish: false,
    });
    expect(await list(canvasId)).toEqual([]);
    expect((await service().status("env-1", canvasId, prepared.token)).state).toBe("canceled");
  });

  test("legacy browser intents import once: tokens reconcile, successes are skipped", async () => {
    const { canvasId, frameId } = await setup();
    const committed = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "update_frame", frameId, patch: { x: 5 } },
      preconditions: { frameRevision: 1 },
    });
    await service().execute("env-1", canvasId, committed.token);
    const base = {
      lane: frameId,
      label: "Legacy",
      createdAt: clock,
      descriptor: {
        canvasId,
        input: { kind: "update_frame", frameId, patch: { x: 6 } },
        preconditions: { frameRevision: 1 },
        clientId: "client-old",
      },
    };
    const result = await importIntents(service(), "env-1", canvasId, "client-a", [
      { ...base, id: "i-draft", phase: "draft" },
      { ...base, id: "i-unknown", phase: "admitted", outcome: "unknown", token: committed.token },
      { ...base, id: "i-done", phase: "settled", outcome: "committed", token: committed.token },
      { id: "broken" },
    ]);
    expect(result).toEqual({ imported: 2, skipped: 2 });
    const intents = await list(canvasId);
    expect(intents.find((intent) => intent.id === "i-draft")).toMatchObject({
      phase: "draft",
      clientId: "client-old",
    });
    // The unknown token was resolved from the backend's receipt, not re-sent.
    expect(intents.find((intent) => intent.id === "i-unknown")).toMatchObject({
      phase: "settled",
      outcome: "committed",
    });
  });

  test("Resume is the consent a prepared token waits for; listing alone never runs it", async () => {
    const { canvasId, frameId } = await setup();
    const draft = move(canvasId, frameId, 1, 55);
    const prepared = await service().prepare("env-1", "user", draft.descriptor);
    await importIntents(service(), "env-1", canvasId, "client-a", [
      { ...draft, phase: "prepared", token: prepared.token },
    ]);
    const listed = await byId(canvasId, draft.id);
    expect(listed).toMatchObject({ phase: "admitted", token: prepared.token });
    expect(listed?.outcome).toBeUndefined();
    expect((await service().status("env-1", canvasId, prepared.token)).state).toBe("prepared");
    const resumed = await resumeIntent(
      service(),
      "env-1",
      canvasId,
      draft.id,
      "client-b",
      undefined,
    );
    expect(resumed.intent).toMatchObject({
      phase: "settled",
      outcome: "committed",
      clientId: "client-b",
    });
    expect((await service().status("env-1", canvasId, prepared.token)).state).toBe("committed");
  });

  test("a run in flight is listed as sending, and its intent cannot be resumed away", async () => {
    const { canvasId, frameId } = await setup();
    const hold = deferred();
    harness.renderer.block = (job) => (job.priority === "interactive" ? hold.promise : undefined);
    const draft: DesignIntentDraft = {
      ...move(canvasId, frameId, 1, 0),
      descriptor: {
        canvasId,
        input: { kind: "set_element_styles", frameId, selector: "h1", styles: { color: "red" } },
        preconditions: { frameRevision: 1 },
        clientId: "client-a",
        correlationId: "i-styled",
      },
      id: "i-styled",
    };
    const interactive = (job: { priority: string }) => job.priority === "interactive";
    const earlier = harness.renderer.jobs.filter(interactive).length;
    const running = runIntent(service(), "env-1", canvasId, draft, 5000);
    await harness.renderer.started(interactive, earlier + 1);
    expect((await listIntents(service(), "env-1", canvasId)).sending).toEqual([draft.id]);
    await expect(
      resumeIntent(service(), "env-1", canvasId, draft.id, "client-b", undefined),
    ).rejects.toMatchObject({ failure: { code: "conflict" } });
    // A repeated run joins nothing: it reports the intent and never prepares a second token.
    expect(await runIntent(service(), "env-1", canvasId, draft, 5000)).toMatchObject({
      intent: { id: draft.id },
    });
    hold.resolve();
    expect((await running).status?.state).toBe("committed");
    expect((await listIntents(service(), "env-1", canvasId)).sending).toEqual([]);
  });

  test("another environment cannot see or disturb this document's queue", async () => {
    const { canvasId, frameId } = await setup();
    const draft = move(canvasId, frameId, 1, 1);
    const denied = { failure: { code: "not-found" } };
    await saveIntentDrafts(service(), "env-1", canvasId, "client-a", [draft]);
    await expect(runIntent(service(), "env-2", canvasId, draft, 0)).rejects.toMatchObject(denied);
    await expect(
      saveIntentDrafts(service(), "env-2", canvasId, "client-a", [draft]),
    ).rejects.toMatchObject(denied);
    await expect(discardIntent(service(), "env-2", canvasId, draft.id)).rejects.toMatchObject(
      denied,
    );
    await expect(
      resumeIntent(service(), "env-2", canvasId, draft.id, "client-a", undefined),
    ).rejects.toMatchObject(denied);
    expect((await byId(canvasId, draft.id))?.phase).toBe("draft");
  });

  test("a rerun of an edit an unobserved run already prepared never prepares again", async () => {
    const { canvasId, frameId } = await setup();
    const draft = move(canvasId, frameId, 1, 10);
    const prepared = await service().prepare("env-1", "user", draft.descriptor);
    const file = service().store.intentsFile(canvasId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify([{ ...draft, clientId: "client-a", updatedAt: clock, phase: "preparing" }]),
    );
    const rerun = await runIntent(service(), "env-1", canvasId, draft, 5000);
    expect(rerun.status).toBeUndefined();
    expect(rerun.intent).toMatchObject({ phase: "admitted", token: prepared.token });
    expect(await service().store.readPending(canvasId)).toHaveLength(1);
    expect((await service().status("env-1", canvasId, prepared.token)).state).toBe("prepared");
  });

  test("after a restart, an edit caught mid-prepare is recovered from backend state", async () => {
    const { canvasId, frameId } = await setup();
    const draft = move(canvasId, frameId, 1, 10);
    // The previous process prepared the token but died before executing it.
    await service().prepare("env-1", "user", draft.descriptor);
    const stranded: DesignStoredIntent[] = [
      { ...draft, clientId: "client-a", updatedAt: clock, phase: "preparing" },
      {
        ...move(canvasId, frameId, 1, 20),
        clientId: "client-a",
        updatedAt: clock,
        phase: "preparing",
      },
    ];
    const file = service().store.intentsFile(canvasId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(stranded));
    await harness.restart(options());
    // Never re-prepared: the dead owner's token is interrupted.
    expect(await byId(canvasId, draft.id)).toMatchObject({
      phase: "settled",
      outcome: "interrupted",
    });
    // A preparing edit without a token stays put while a live call might own it, then is a draft.
    expect((await byId(canvasId, stranded[1]!.id))?.phase).toBe("preparing");
    clock += DESIGN_INTENT_LIMITS.preparingGraceMs;
    expect((await byId(canvasId, stranded[1]!.id))?.phase).toBe("draft");
  });

  test("removing a canvas's files removes its intent queue", async () => {
    const { canvasId, frameId } = await setup();
    await saveIntentDrafts(service(), "env-1", canvasId, "client-a", [
      move(canvasId, frameId, 1, 1),
    ]);
    expect(await readIntents(service(), canvasId)).toHaveLength(1);
    await service().store.remove(canvasId);
    await expect(access(service().store.intentsFile(canvasId))).rejects.toThrow();
  });
});
