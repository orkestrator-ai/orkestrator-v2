import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_ROLLOUT_ENV,
  WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS,
  parseWebAnnotationError,
  type WebAnnotationRolloutMode,
} from "@orkestrator/protocol/web-annotations";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerWebAnnotationCommands } from "./commands-registry-web-annotations.js";
import { WebAnnotationRollout } from "./web-annotation-rollout.js";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import { sendRequest } from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("rollout mode resolution", () => {
  test("defaults to enabled, follows the setting, and the environment override wins", async () => {
    let setting: unknown;
    const rollout = new WebAnnotationRollout(async () => setting, {});
    await rollout.refresh();
    expect(rollout.mode).toBe("enabled");
    setting = { mode: "read-only" };
    await rollout.refresh();
    expect(rollout.snapshot()).toEqual({
      mode: "read-only",
      configured: "read-only",
      override: null,
    });
    const overridden = new WebAnnotationRollout(async () => ({ mode: "enabled" }), {
      [WEB_ANNOTATION_ROLLOUT_ENV]: "disabled",
    });
    await overridden.refresh();
    expect(overridden.snapshot()).toEqual({
      mode: "disabled",
      configured: "enabled",
      override: "disabled",
    });
    expect(
      new WebAnnotationRollout(async () => undefined, { [WEB_ANNOTATION_ROLLOUT_ENV]: "bogus" })
        .mode,
    ).toBe("enabled");
    // A failed settings read keeps the last known mode.
    const failing = new WebAnnotationRollout(async () => {
      throw new Error("config unreadable");
    }, {});
    failing.setConfigured("read-only");
    await failing.refresh();
    expect(failing.mode).toBe("read-only");
  });
});

describe("capabilities per mode", () => {
  test("enabled advertises only submittable capture targets", async () => {
    harness = await createHarness();
    const capabilities = await harness.service.capabilities(ENV_A);
    expect(capabilities.mode).toBe("enabled");
    expect(capabilities.targets).toEqual([...WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS]);
    expect(capabilities.targets).not.toContain("legacy-unresolved");
    expect(capabilities.operations).toMatchObject({
      read: true,
      author: true,
      dispatch: true,
      resolve: true,
      recover: true,
      archive: true,
    });
  });

  test("read-only is recovery mode and disabled turns every entry point off", async () => {
    let mode: WebAnnotationRolloutMode = "read-only";
    harness = await createHarness({ rolloutMode: () => mode });
    const readOnly = await harness.service.capabilities(ENV_A);
    expect(readOnly.mode).toBe("read-only");
    expect(readOnly.operations).toMatchObject({
      read: true,
      resolve: true,
      recover: true,
      author: false,
      captureAccept: false,
      dispatch: false,
      batch: false,
      migration: false,
      archive: false,
    });
    expect(readOnly.targets).toEqual([]);
    mode = "disabled";
    const disabled = await harness.service.capabilities(ENV_A);
    expect(disabled.operations).toMatchObject({
      read: false,
      resolve: false,
      recover: false,
      author: false,
      dispatch: false,
    });
  });
});

function registry() {
  const commands = new Map<string, CommandHandler>();
  registerWebAnnotationCommands((name, handler) => commands.set(name, handler));
  return commands;
}

describe("command gating", () => {
  async function setup(initial: WebAnnotationRolloutMode) {
    let persisted: unknown = { mode: initial };
    const rollout = new WebAnnotationRollout(async () => persisted, {});
    await rollout.refresh();
    harness = await createHarness({ rolloutMode: () => rollout.mode });
    const config = { global: { theme: "dark" } as Record<string, unknown>, repositories: {} };
    const context = {
      storage: {
        getEnvironment: async (id: string) => ({ id }),
        loadConfig: async () => structuredClone(config),
        updateGlobalConfig: async (global: Record<string, unknown>) => {
          config.global = global;
          persisted = global.webAnnotations;
          return config;
        },
      },
      emit: () => undefined,
      webAnnotations: harness.service,
      webAnnotationRollout: rollout,
    } as unknown as CommandContext;
    const commands = registry();
    const call = async (name: string, args: Record<string, unknown>) => {
      const handler = commands.get(name);
      if (!handler) throw new Error(`missing ${name}`);
      return (await handler(args, context)) as any;
    };
    return { call, config, rollout };
  }

  test("read-only keeps reads, resolution, drafts, and in-flight recovery", async () => {
    const { call } = await setup("enabled");
    const receipt = await createAnnotation(harness!.service, ENV_A);
    await sendRequest(harness!.service, receipt.annotationId, "req-1");
    await call(WEB_ANNOTATION_COMMANDS.rolloutSet, { mode: "read-only" });

    const refused = await call(WEB_ANNOTATION_COMMANDS.create, {
      environmentId: ENV_A,
      operationId: "op-new",
      capture: fixtureCaptureInput(),
      body: "new",
    }).catch((error) => error);
    expect(parseWebAnnotationError(refused).detail).toEqual({
      code: "read-only",
      mode: "read-only",
    });
    for (const command of [
      WEB_ANNOTATION_COMMANDS.requestPrepare,
      WEB_ANNOTATION_COMMANDS.requestSend,
      WEB_ANNOTATION_COMMANDS.assetStage,
      WEB_ANNOTATION_COMMANDS.migrate,
      WEB_ANNOTATION_COMMANDS.archive,
    ]) {
      const error = await call(command, { environmentId: ENV_A }).catch((caught) => caught);
      expect(parseWebAnnotationError(error).detail?.code).toBe("read-only");
    }
    expect((await call(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A })).total).toBe(1);
    await call(WEB_ANNOTATION_COMMANDS.draftSave, {
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "still typing",
    });
    const cancelled = await call(WEB_ANNOTATION_COMMANDS.requestCancel, {
      environmentId: ENV_A,
      requestId: "req-1",
      expectedRevision: (await harness!.service.getRequest(ENV_A, "req-1")).request.revision,
    });
    expect(cancelled.outcome).toBe("cancelled");
    const { annotation } = await harness!.service.get(ENV_A, receipt.annotationId);
    const resolved = await call(WEB_ANNOTATION_COMMANDS.resolve, {
      environmentId: ENV_A,
      operationId: "op-resolve",
      annotationId: receipt.annotationId,
      expectedContentRevision: annotation.contentRevision,
      expectedCaptureId: annotation.currentCaptureId,
    });
    expect(resolved.annotationId).toBe(receipt.annotationId);
  });

  test("disabled refuses everything but capabilities and operator surfaces; reconciliation continues", async () => {
    const { call, config } = await setup("enabled");
    const receipt = await createAnnotation(harness!.service, ENV_A);
    await sendRequest(harness!.service, receipt.annotationId, "req-1");
    const snapshot = await call(WEB_ANNOTATION_COMMANDS.rolloutSet, { mode: "disabled" });
    expect(snapshot).toEqual({ mode: "disabled", configured: "disabled", override: null });
    expect(config.global).toMatchObject({ theme: "dark", webAnnotations: { mode: "disabled" } });
    const error = await call(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A }).catch(
      (caught) => caught,
    );
    expect(parseWebAnnotationError(error).detail).toEqual({ code: "disabled", mode: "disabled" });
    expect((await call(WEB_ANNOTATION_COMMANDS.capabilities, {})).operations.read).toBe(false);
    expect((await call(WEB_ANNOTATION_COMMANDS.rollout, {})).mode).toBe("disabled");
    // Requests already sent keep settling in the background.
    harness!.dispatch.observe_("req-1", "running");
    await harness!.service.reconcileOnce();
    expect((await harness!.service.getRequest(ENV_A, "req-1")).request.state).toBe("running");
    // Persisted data is untouched and readable again after re-enabling.
    await call(WEB_ANNOTATION_COMMANDS.rolloutSet, { mode: "enabled" });
    expect((await call(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A })).total).toBe(1);
  });
});

describe("metrics", () => {
  test("record content-free command outcomes, commits, and request transitions", async () => {
    const commands = registry();
    harness = await createHarness();
    const context = {
      storage: { getEnvironment: async (id: string) => ({ id }) },
      emit: () => undefined,
      webAnnotations: harness.service,
    } as unknown as CommandContext;
    const call = (name: string, args: Record<string, unknown>) =>
      Promise.resolve(commands.get(name)!(args, context));
    const receipt = (await call(WEB_ANNOTATION_COMMANDS.create, {
      environmentId: ENV_A,
      operationId: "op-metric",
      capture: fixtureCaptureInput(),
      body: "METRIC-SECRET body",
    })) as { annotationId: string };
    await call(WEB_ANNOTATION_COMMANDS.entryAppend, {
      environmentId: ENV_A,
      operationId: "op-stale",
      annotationId: receipt.annotationId,
      expectedContentRevision: 42,
      body: "METRIC-SECRET stale",
    }).catch(() => undefined);
    await sendRequest(harness.service, receipt.annotationId, "req-metric");
    harness.dispatch.observe_("req-metric", "running");
    await harness.service.reconcileOnce();
    harness.dispatch.observe_("req-metric", "awaiting-review");
    await harness.service.reconcileOnce();
    const snapshot = (await call(WEB_ANNOTATION_COMMANDS.metrics, {})) as ReturnType<
      typeof harness.service.metrics.snapshot
    >;
    expect(snapshot.counters["commands|command=web_annotation_create|outcome=ok"]).toBe(1);
    expect(snapshot.counters["commands|command=web_annotation_entry_append|outcome=conflict"]).toBe(
      1,
    );
    expect(snapshot.counters["storage_commits|scope=manifest"]).toBeGreaterThan(0);
    expect(snapshot.counters["requests_created|operation=implement"]).toBe(1);
    expect(snapshot.counters["request_transitions|from=prepared|to=queued"]).toBe(1);
    expect(snapshot.counters["request_transitions|from=queued|to=running"]).toBe(1);
    expect(snapshot.counters["request_transitions|from=running|to=awaiting-review"]).toBe(1);
    expect(snapshot.durations["request_dispatch_ms|operation=implement"]?.count).toBe(1);
    expect(
      snapshot.durations["request_duration_ms|operation=implement|state=awaiting-review"]?.count,
    ).toBe(1);
    expect(snapshot.durations["storage_commit_ms|scope=manifest"]?.count).toBeGreaterThan(0);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("METRIC-SECRET");
    expect(serialized).not.toContain("req-metric");
    expect(serialized).not.toContain(receipt.annotationId);
  });
});
