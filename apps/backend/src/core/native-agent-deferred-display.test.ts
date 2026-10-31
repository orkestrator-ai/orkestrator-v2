/**
 * Large tool input values and finished reasoning reach a reader as previews,
 * with the whole value behind a detail reference fetched on expand.
 */
import { describe, expect, test } from "bun:test";

import {
  NATIVE_DEFERRED_THINKING_PREVIEW_CHARS,
  NATIVE_DEFERRED_TOOL_ARG_PREVIEW_CHARS,
  deferredDisplayPreview,
  deferredThinkingPreview,
  deferredToolArgsPreview,
} from "./native-agent-deferred-display.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

import { NATIVE_TOOL_DETAIL_MAX_BYTES } from "./native-agent-service-shared.js";

const LARGE = "x".repeat(5_000);

function settledTool(toolName: string, toolArgs: Record<string, unknown>) {
  return { type: "tool-invocation", content: toolName, toolName, toolState: "success", toolArgs };
}

describe("deferred display previews", () => {
  test("cuts a value to its preview and marks the cut", () => {
    expect(deferredDisplayPreview("short", 10)).toBe("short");
    expect(deferredDisplayPreview("abcdef", 3)).toBe("abc…");
  });

  test("never splits a surrogate pair", () => {
    // The budget lands between the two halves of the emoji.
    expect(deferredDisplayPreview("ab😀cd", 3)).toBe("ab…");
  });

  test("defers only large content fields of a settled call", () => {
    const args = { file_path: "/w/src/app.ts", content: LARGE };
    const preview = deferredToolArgsPreview(settledTool("Write", args), args);
    expect(preview).toEqual({
      file_path: "/w/src/app.ts",
      content: `${LARGE.slice(0, NATIVE_DEFERRED_TOOL_ARG_PREVIEW_CHARS)}…`,
    });
    // The provider's input is not mutated.
    expect(args.content).toBe(LARGE);
  });

  test("measures the threshold in UTF-8 bytes", () => {
    // 400 three-byte characters are 1,200 bytes: over the threshold.
    const args = { file_path: "/w/a.txt", content: "€".repeat(400) };
    expect(deferredToolArgsPreview(settledTool("Write", args), args)).toBeDefined();
    const small = { file_path: "/w/a.txt", content: "a".repeat(1_000) };
    expect(deferredToolArgsPreview(settledTool("Write", small), small)).toBeUndefined();
  });

  test("keeps the input a collapsed card or header draws", () => {
    for (const args of [
      { command: LARGE },
      { prompt: LARGE, description: "Explore" },
      { body: LARGE, toEnvironmentId: "env-2" },
      { plan: LARGE },
    ]) {
      expect(deferredToolArgsPreview(settledTool("Tool", args), args)).toBeUndefined();
    }
  });

  test("keeps the whole input of a running call", () => {
    const args = { file_path: "/w/a.ts", content: LARGE };
    const part = { ...settledTool("Write", args), toolState: "pending" };
    expect(deferredToolArgsPreview(part, args)).toBeUndefined();
  });

  test("keeps a plan file's contents for the plan approval card", () => {
    const args = { file_path: "/home/u/.claude/plans/feature-plan.md", content: LARGE };
    expect(deferredToolArgsPreview(settledTool("Write", args), args)).toBeUndefined();
  });

  test("defers reasoning only once the row has moved past it", () => {
    const part = { type: "thinking", content: LARGE };
    expect(deferredThinkingPreview(part, false)).toBeUndefined();
    expect(deferredThinkingPreview(part, true)).toBe(
      `${LARGE.slice(0, NATIVE_DEFERRED_THINKING_PREVIEW_CHARS)}…`,
    );
    expect(deferredThinkingPreview({ type: "thinking", content: "brief" }, true)).toBeUndefined();
  });
});

describe("NativeAgentService deferred display", () => {
  const identity = {
    environmentId: "env-1",
    agent: "codex" as const,
    logicalSessionKey: "env-env-1:tab-deferred-display",
  };
  type ProjectedPart = {
    type: string;
    content: string;
    toolArgs?: Record<string, unknown>;
    toolArgsDetailRef?: string;
    contentDetailRef?: string;
  };

  function serviceFor(messages: unknown[], snapshots: { count: number } = { count: 0 }) {
    return createProviderStub("codex", {
      interactiveSnapshot: async () => {
        snapshots.count += 1;
        return { status: "idle", messages };
      },
    });
  }

  test("sends previews and serves the whole input and reasoning on expand", async () => {
    const grant = "oag1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const reasoning = "Reasoning about the change. ".repeat(200);
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "",
        parts: [
          { type: "thinking", content: reasoning },
          settledTool("Write", {
            file_path: "/w/src/app.ts",
            content: LARGE,
            scopeCapability: grant,
          }),
          { type: "thinking", content: reasoning },
        ],
        createdAt: "2026-10-31T10:00:00.000Z",
      },
    ];
    const stub = serviceFor(messages);
    await withService(
      { prefix: "orkestrator-native-deferred-display-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const parts = (projection!.messages[0] as { parts: ProjectedPart[] }).parts;
        const [thinking, write, lastThinking] = parts;

        expect(thinking!.content).toBe(
          `${reasoning.slice(0, NATIVE_DEFERRED_THINKING_PREVIEW_CHARS)}…`,
        );
        expect(thinking!.contentDetailRef).toBeString();
        // Still the last part of its row: it may be streaming, so it stays whole.
        expect(lastThinking!.content).toBe(reasoning);
        expect(lastThinking!.contentDetailRef).toBeUndefined();

        expect(write!.toolArgs!.file_path).toBe("/w/src/app.ts");
        expect(write!.toolArgs!.content).toBe(
          `${LARGE.slice(0, NATIVE_DEFERRED_TOOL_ARG_PREVIEW_CHARS)}…`,
        );
        expect(write!.toolArgsDetailRef).toBeString();
        expect(JSON.stringify(projection)).not.toContain(grant);

        const argsDetail = await service.getProjectionToolDetails({
          ...identity,
          detailRef: write!.toolArgsDetailRef!,
        });
        expect(argsDetail.toolArgs).toEqual({
          file_path: "/w/src/app.ts",
          content: LARGE,
          scopeCapability: "[redacted]",
        });
        const thinkingDetail = await service.getProjectionToolDetails({
          ...identity,
          detailRef: thinking!.contentDetailRef!,
        });
        expect(thinkingDetail.thinking).toBe(reasoning);
      },
    );
  });

  for (const kind of ["args", "thinking"] as const) {
    for (const extra of [-1, 0, 1, 128]) {
      test(`${kind} remains reachable at the encoded detail ceiling ${extra >= 0 ? "+" : ""}${extra}`, async () => {
        // Include multibyte UTF-8 and JSON escaping, not only ASCII lengths.
        const seed = '€"\\\n'.repeat(1_000);
        const details = (body: string) =>
          kind === "args"
            ? { toolArgs: { file_path: "/w/a.ts", content: body } }
            : { thinking: body };
        // Cache entries reserve 32 characters for the reference and 32 bytes
        // for bookkeeping, in addition to the encoded details object.
        const body =
          seed +
          "x".repeat(
            NATIVE_TOOL_DETAIL_MAX_BYTES +
              extra -
              64 -
              Buffer.byteLength(JSON.stringify(details(seed))),
          );
        expect(Buffer.byteLength(JSON.stringify(details(body))) + 64).toBe(
          NATIVE_TOOL_DETAIL_MAX_BYTES + extra,
        );
        const messages = [
          {
            id: "boundary",
            role: "assistant" as const,
            content: "",
            createdAt: "2026-10-31T10:00:00.000Z",
            parts: [
              kind === "args"
                ? settledTool("Write", { file_path: "/w/a.ts", content: body })
                : { type: "thinking", content: body },
              { type: "text", content: "Done" },
            ],
          },
        ];
        const stub = serviceFor(messages);
        await withService(
          { prefix: "orkestrator-native-deferred-limit-", provider: async () => stub.provider },
          async ({ service }) => {
            await service.ensureSession(identity);
            const projection = await service.getProjection(identity);
            const part = (projection!.messages[0] as { parts: ProjectedPart[] }).parts[0]!;
            const ref = kind === "args" ? part.toolArgsDetailRef : part.contentDetailRef;
            if (extra <= 0) {
              expect(ref).toBeString();
              const detail = await service.getProjectionToolDetails({
                ...identity,
                detailRef: ref!,
              });
              expect(kind === "args" ? detail.toolArgs!.content : detail.thinking).toBe(body);
              expect(detail.toolError).toBeUndefined();
            } else {
              expect(ref).toBeUndefined();
              expect(kind === "args" ? part.toolArgs!.content : part.content).toBe(body);
            }
          },
        );
      });
    }
  }

  test("re-reads the provider when a deferred input was evicted", async () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "",
        parts: [settledTool("Edit", { file_path: "/w/a.ts", old_string: LARGE, new_string: "y" })],
        createdAt: "2026-10-31T10:00:00.000Z",
      },
    ];
    const snapshots = { count: 0 };
    const stub = serviceFor(messages, snapshots);
    await withService(
      { prefix: "orkestrator-native-deferred-eviction-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const part = (projection!.messages[0] as { parts: ProjectedPart[] }).parts[0]!;
        // Only the large value is cut.
        expect(part.toolArgs!.new_string).toBe("y");

        projectionInternals(service).evictToolDetails();
        const before = snapshots.count;
        const detail = await service.getProjectionToolDetails({
          ...identity,
          detailRef: part.toolArgsDetailRef!,
        });
        expect(detail.toolArgs!.old_string).toBe(LARGE);
        expect(snapshots.count).toBeGreaterThan(before);
      },
    );
  });
});
