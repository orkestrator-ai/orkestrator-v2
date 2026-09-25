/**
 * Gateway authorization scope for web annotation commands.
 *
 * Findings this suite documents (step 03): the gateway authenticates one
 * user credential (the gateway token / session cookie). It carries no
 * environment scope — an authenticated client may address every environment
 * of this backend, exactly like every other environment-scoped command
 * (terminals, files, drafts). Environment-scoped credentials exist only for
 * agent tools (tab-bound tool connections, covered by the tools suite).
 *
 * What is enforced for annotations, and tested here end to end through the
 * real gateway: unauthenticated calls never reach a handler; the
 * request-body `environmentId` is the only scope, it must name an existing
 * environment that is not being deleted, and every record lookup (annotation,
 * capture, asset, draft, request) is confined to that environment, so naming
 * a different environment can never reach another environment's records.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WEB_ANNOTATION_COMMANDS,
  parseWebAnnotationError,
} from "@orkestrator/protocol/web-annotations";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import { OrkestratorGateway } from "../gateway.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerWebAnnotationCommands } from "./commands-registry-web-annotations.js";
import {
  ENV_A,
  ENV_B,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import { sendRequest } from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
let gateway: OrkestratorGateway | undefined;
let rendererRoot: string | undefined;
afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  await harness?.cleanup();
  harness = undefined;
  if (rendererRoot) await rm(rendererRoot, { recursive: true, force: true });
  rendererRoot = undefined;
});

const TOKEN = "gateway-scope-token-1234567890";

async function start() {
  harness = await createHarness();
  const commands = new Map<string, CommandHandler>();
  registerWebAnnotationCommands((name, handler) => commands.set(name, handler));
  const environments = new Set([ENV_A, ENV_B]);
  const context = {
    storage: {
      getEnvironment: async (id: string) => (environments.has(id) ? { id } : null),
    },
    emit: () => undefined,
    webAnnotations: harness.service,
  } as unknown as CommandContext;
  rendererRoot = await mkdtemp(join(tmpdir(), "ork-wa-gateway-"));
  await mkdir(join(rendererRoot, "dist"));
  await writeFile(join(rendererRoot, "dist", "index.html"), "<div></div>");
  gateway = new OrkestratorGateway({
    backend: {
      invoke: async (command, args) => {
        const handler = commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return handler(args, context);
      },
      hasCommand: (command) => commands.has(command),
    },
    dataDir: rendererRoot,
    rendererRoot: join(rendererRoot, "dist"),
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: TOKEN },
    logger: {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
    allowNonTailscaleBind: true,
  });
  const info = await gateway.start();
  if (!info) throw new Error("gateway did not start");
  const invoke = async (
    command: string,
    args: Record<string, unknown>,
    token: string | null = TOKEN,
  ) => {
    const response = await fetch(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ command, args }),
    });
    const body = (await response.json().catch(() => null)) as {
      result?: any;
      error?: string;
    } | null;
    return { status: response.status, result: body?.result, error: body?.error ?? null };
  };
  return { invoke, environments };
}

describe("web annotation commands through the authenticated gateway", () => {
  test("unauthenticated or wrongly authenticated calls never reach the service", async () => {
    const { invoke } = await start();
    let reached = false;
    const original = harness!.service.list.bind(harness!.service);
    harness!.service.list = async (input) => {
      reached = true;
      return original(input);
    };
    expect(
      (await invoke(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A }, null)).status,
    ).toBe(401);
    expect(
      (await invoke(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A }, "wrong-token-000000"))
        .status,
    ).toBe(401);
    expect(reached).toBe(false);
    expect((await invoke(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_A })).status).toBe(200);
    expect(reached).toBe(true);
  });

  test("a request-body environment id cannot reach another environment's records", async () => {
    const { invoke, environments } = await start();
    const asset = await invoke(WEB_ANNOTATION_COMMANDS.assetStage, {
      environmentId: ENV_A,
      operationId: "op-asset",
      mediaType: "image/png",
      data: makePng().toString("base64"),
    });
    expect(asset.status).toBe(200);
    const created = await invoke(WEB_ANNOTATION_COMMANDS.create, {
      environmentId: ENV_A,
      operationId: "op-create",
      capture: { ...fixtureCaptureInput("element"), assetIds: [asset.result.asset.id] },
      body: "Environment A only",
    });
    expect(created.status).toBe(200);
    const { annotationId, captureId } = created.result;
    await harness!.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "draft in A",
    });
    await sendRequest(harness!.service, annotationId, "req-a");

    // The single user credential may address environment B by design...
    const listB = await invoke(WEB_ANNOTATION_COMMANDS.list, { environmentId: ENV_B });
    expect(listB.status).toBe(200);
    expect(listB.result.total).toBe(0);
    // ...but naming B never reaches A's records.
    const crossReads: Array<[string, Record<string, unknown>]> = [
      [WEB_ANNOTATION_COMMANDS.get, { environmentId: ENV_B, annotationId }],
      [WEB_ANNOTATION_COMMANDS.capture, { environmentId: ENV_B, captureId }],
      [WEB_ANNOTATION_COMMANDS.assetGet, { environmentId: ENV_B, assetId: asset.result.asset.id }],
      [WEB_ANNOTATION_COMMANDS.requestGet, { environmentId: ENV_B, requestId: "req-a" }],
      [WEB_ANNOTATION_COMMANDS.entries, { environmentId: ENV_B, annotationId, afterSequence: 0 }],
    ];
    for (const [command, args] of crossReads) {
      const response = await invoke(command, args);
      expect(response.status).toBe(500);
      expect(parseWebAnnotationError(response.error).detail?.code).toBe("not-found");
      expect(response.error).not.toContain("Environment A only");
    }
    const draftB = await invoke(WEB_ANNOTATION_COMMANDS.draftGet, {
      environmentId: ENV_B,
      editorId: "ed-1",
    });
    expect(draftB.result).toEqual({ draft: null });
    const crossWrite = await invoke(WEB_ANNOTATION_COMMANDS.entryAppend, {
      environmentId: ENV_B,
      operationId: "op-cross",
      annotationId,
      expectedContentRevision: 1,
      body: "written through B",
    });
    expect(parseWebAnnotationError(crossWrite.error).detail?.code).toBe("not-found");
    const bodies = (await harness!.service.get(ENV_A, annotationId)).entries.map((e) => e.body);
    expect(bodies).not.toContain("written through B");

    // An unknown or deleting environment is refused before the service runs.
    for (const environmentId of ["env-unknown", ENV_B]) {
      if (environmentId === ENV_B) environments.delete(ENV_B);
      const refused = await invoke(WEB_ANNOTATION_COMMANDS.list, { environmentId });
      expect(refused.status).toBe(500);
      expect(refused.error).toBe("Environment not found");
    }
    // Payload-declared provenance never crosses the boundary.
    const forged = await invoke(WEB_ANNOTATION_COMMANDS.entryAppend, {
      environmentId: ENV_A,
      operationId: "op-forged",
      annotationId,
      expectedContentRevision: 1,
      body: "forged",
      provenance: "host-user",
    });
    expect(forged.status).toBe(500);
  });
});
