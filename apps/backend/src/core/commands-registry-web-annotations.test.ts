import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureCaptureInput,
  fixtureDestination,
} from "@orkestrator/protocol/web-annotations-fixtures";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerWebAnnotationCommands } from "./commands-registry-web-annotations.js";
import type { WebAnnotationService } from "./web-annotation-service.js";
import {
  ENV_A,
  ENV_B,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function registry() {
  const commands = new Map<string, CommandHandler>();
  registerWebAnnotationCommands((name, handler) => commands.set(name, handler));
  return commands;
}

function contextFor(
  service: WebAnnotationService | undefined,
  environments: Record<string, { deletionRequestedAt?: string }> = { [ENV_A]: {}, [ENV_B]: {} },
) {
  return {
    storage: {
      getEnvironment: async (id: string) => (environments[id] ? { id, ...environments[id] } : null),
    },
    emit: () => undefined,
    webAnnotations: service,
  } as unknown as CommandContext;
}

async function call(
  commands: Map<string, CommandHandler>,
  context: CommandContext,
  name: string,
  args: Record<string, unknown>,
) {
  const handler = commands.get(name);
  if (!handler) throw new Error(`missing ${name}`);
  return (await handler(args, context)) as any;
}

describe("web annotation commands", () => {
  test("registers every contract command", () => {
    const commands = registry();
    for (const name of Object.values(WEB_ANNOTATION_COMMANDS))
      expect(commands.has(name)).toBe(true);
  });

  test("an unavailable service reports unavailable capabilities and clear errors", async () => {
    const commands = registry();
    const context = contextFor(undefined);
    const capabilities = await call(commands, context, WEB_ANNOTATION_COMMANDS.capabilities, {});
    expect(capabilities).toMatchObject({
      storage: "unavailable",
      operations: { read: false, dispatch: false },
    });
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A }),
    ).rejects.toThrow("Web annotation service unavailable");
  });

  test("end-to-end create, list, prepare, and send through commands", async () => {
    harness = await createHarness();
    const commands = registry();
    const context = contextFor(harness.service);
    const capabilities = await call(commands, context, WEB_ANNOTATION_COMMANDS.capabilities, {
      environmentId: ENV_A,
    });
    expect(capabilities).toMatchObject({
      storage: "ready",
      maxRequestAnnotations: 20,
      operations: { dispatch: true, batch: true },
    });
    const receipt = await call(commands, context, WEB_ANNOTATION_COMMANDS.create, {
      environmentId: ENV_A,
      operationId: "op-1",
      capture: fixtureCaptureInput(),
      body: "Make it roomier",
    });
    const list = await call(commands, context, WEB_ANNOTATION_COMMANDS.list, {
      environmentId: ENV_A,
    });
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([receipt.annotationId]);
    const preparation = await call(commands, context, WEB_ANNOTATION_COMMANDS.requestPrepare, {
      environmentId: ENV_A,
      operation: "implement",
      destination: fixtureDestination,
      annotations: [
        {
          annotationId: receipt.annotationId,
          expectedContentRevision: 1,
          expectedCaptureId: receipt.captureId,
        },
      ],
      instruction: "",
    });
    const sent = await call(commands, context, WEB_ANNOTATION_COMMANDS.requestSend, {
      environmentId: ENV_A,
      preparationId: preparation.preparationId,
      requestId: "req-1",
      bodyHash: preparation.bodyHash,
    });
    expect(sent.request.state).toBe("queued");
    const requests = await call(commands, context, WEB_ANNOTATION_COMMANDS.requestList, {
      environmentId: ENV_A,
      activeOnly: true,
    });
    expect(requests.requests.map((request: { id: string }) => request.id)).toEqual(["req-1"]);
  });

  test("request-body environment ids cannot read another environment's records", async () => {
    harness = await createHarness();
    const commands = registry();
    const context = contextFor(harness.service);
    const staged = await call(commands, context, WEB_ANNOTATION_COMMANDS.assetStage, {
      environmentId: ENV_A,
      operationId: "op-a",
      mediaType: "image/png",
      data: makePng().toString("base64"),
    });
    const receipt = await call(commands, context, WEB_ANNOTATION_COMMANDS.create, {
      environmentId: ENV_A,
      operationId: "op-1",
      capture: { ...fixtureCaptureInput(), assetIds: [staged.asset.id] },
      body: "private",
    });
    await call(commands, context, WEB_ANNOTATION_COMMANDS.draftSave, {
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "x",
    });
    await harness.service.send({
      environmentId: ENV_A,
      requestId: "req-1",
      ...(await (async () => {
        const preparation = await harness!.service.prepare({
          environmentId: ENV_A,
          operation: "discuss",
          destination: fixtureDestination,
          annotations: [
            {
              annotationId: receipt.annotationId,
              expectedContentRevision: 1,
              expectedCaptureId: receipt.captureId,
            },
          ],
          instruction: "",
        });
        return { preparationId: preparation.preparationId, bodyHash: preparation.bodyHash };
      })()),
    });
    const denied: Array<[string, Record<string, unknown>]> = [
      [WEB_ANNOTATION_COMMANDS.get, { environmentId: ENV_B, annotationId: receipt.annotationId }],
      [WEB_ANNOTATION_COMMANDS.capture, { environmentId: ENV_B, captureId: receipt.captureId }],
      [WEB_ANNOTATION_COMMANDS.assetGet, { environmentId: ENV_B, assetId: staged.asset.id }],
      [WEB_ANNOTATION_COMMANDS.requestGet, { environmentId: ENV_B, requestId: "req-1" }],
      [WEB_ANNOTATION_COMMANDS.requestResponse, { environmentId: ENV_B, requestId: "req-1" }],
      [
        WEB_ANNOTATION_COMMANDS.entries,
        { environmentId: ENV_B, annotationId: receipt.annotationId, afterSequence: 0 },
      ],
      [
        WEB_ANNOTATION_COMMANDS.entryAppend,
        {
          environmentId: ENV_B,
          operationId: "op-x",
          annotationId: receipt.annotationId,
          expectedContentRevision: 1,
          body: "hijack",
        },
      ],
    ];
    for (const [name, args] of denied) {
      await expect(call(commands, context, name, args)).rejects.toThrow("not found");
    }
    expect(
      (
        await call(commands, context, WEB_ANNOTATION_COMMANDS.draftGet, {
          environmentId: ENV_B,
          editorId: "ed-1",
        })
      ).draft,
    ).toBeNull();
    // A deleted or unknown environment is rejected before the service runs.
    const deleting = contextFor(harness.service, { [ENV_A]: { deletionRequestedAt: "now" } });
    await expect(
      call(commands, deleting, WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A }),
    ).rejects.toThrow("Environment not found");
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.list, { environmentId: "env-unknown" }),
    ).rejects.toThrow("Environment not found");
  });

  test("rejects unbounded payloads, unknown fields, and declared provenance before the service runs", async () => {
    let calls = 0;
    const spy = new Proxy({} as WebAnnotationService, {
      get: () => () => {
        calls++;
        return {};
      },
    });
    const commands = registry();
    const context = contextFor(spy);
    const base = {
      environmentId: ENV_A,
      operationId: "op-1",
      capture: fixtureCaptureInput(),
      body: "ok",
    };
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.create, {
        ...base,
        body: "x".repeat(300 * 1024),
      }),
    ).rejects.toThrow("too large");
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.create, { ...base, extra: true }),
    ).rejects.toThrow("Invalid");
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.create, { ...base, provenance: "host-user" }),
    ).rejects.toThrow("Provenance is assigned by the receiver");
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.create, {
        ...base,
        capture: { ...fixtureCaptureInput(), provenance: "host-user" },
      }),
    ).rejects.toThrow("Provenance");
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.assetStage, {
        environmentId: ENV_A,
        operationId: "op-2",
        mediaType: "image/png",
        data: "A".repeat(Math.ceil(WEB_ANNOTATION_LIMITS.imageBytes / 3) * 4 + 4),
      }),
    ).rejects.toThrow();
    await expect(
      call(commands, context, WEB_ANNOTATION_COMMANDS.requestPrepare, {
        environmentId: ENV_A,
        operation: "implement",
        destination: fixtureDestination,
        annotations: Array.from({ length: 21 }, (_, index) => ({
          annotationId: `a${index}`,
          expectedContentRevision: 1,
          expectedCaptureId: `c${index}`,
        })),
        instruction: "",
      }),
    ).rejects.toThrow("Invalid");
    expect(calls).toBe(0);
  });
});
