import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ChangeProjection,
  CanonicalToolPresentation,
} from "@orkestrator/protocol/change-resources";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { invoke } from "@/lib/native/backend";
import { createAgentHandoffSnapshot } from "@/lib/agent-handoff";
import { toolPresentationKey, useChangeProjectionStore } from "@/stores/changeProjectionStore";
import { resolveAgentHandoffChangeSummaries } from "./handoff";
import { formatLineCount } from "./labels";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const SCOPE = { environmentId: "env-1", provider: "claude", conversationId: "conv-1" };

function projection(resourceKey: string, measurementId: string | null): ChangeProjection {
  return {
    schemaVersion: 1,
    resourceKey,
    ownerGeneration: "gen-1",
    revision: 1,
    measurementId,
    state: "ready",
    availability: "ready",
    observationState: "fresh",
    coverageState: "complete",
    labelKey: "changes.scope.tool-effect",
    labelArgs: {},
    hasFileChanges: true,
    hasTextChanges: true,
    badge: { visible: true, mode: "counts" },
    counters: {
      additions: { value: null, quality: "unknown", bound: "none" },
      deletions: { value: 2, quality: "complete", bound: "exact" },
      changedFiles: 1,
    },
    provenanceLabelKey: "changes.provenance.observed-fresh",
    reasonKeys: [],
    freshness: {
      lastAttemptAt: null,
      lastSuccessfulCheckAt: null,
      lastContentChangeObservedAt: null,
      observedAt: null,
      requiredObservationEpoch: null,
      checkedObservationEpoch: null,
    },
    detail: null,
    filePage: null,
    actions: [],
  };
}

function presentation(callId: string, keys: string[]): CanonicalToolPresentation {
  const roles = ["effect", "payload"] as const;
  return {
    schemaVersion: 1,
    operationId: `op-${callId}`,
    attemptId: `attempt-${callId}`,
    revision: 1,
    toolKind: "file-edit",
    lifecycle: { phase: "succeeded", executionOccurrence: "started" },
    changes: keys.map((resourceKey, index) => ({
      role: roles[Math.min(index, 1)]!,
      resourceKey,
      prominence: index === 0 ? ("primary" as const) : ("secondary" as const),
    })),
  };
}

const messages: NativeMessage[] = [
  {
    id: "a-1",
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-group",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "",
            toolName: "Edit",
            toolUseId: "call-edit",
            toolDiff: { filePath: "src/a.ts" },
          },
          { type: "tool-invocation", content: "", toolName: "Bash", toolUseId: "call-shell" },
          {
            type: "tool-invocation",
            content: "",
            toolName: "Write",
            toolUseId: "call-unmeasured",
            toolDiff: { filePath: "src/b.ts" },
          },
        ],
      },
    ],
    createdAt: "2026-10-20T10:00:00.000Z",
  },
];

describe("resolveAgentHandoffChangeSummaries", () => {
  beforeEach(() => {
    useChangeProjectionStore.setState({
      projections: new Map(),
      deleted: new Set(),
      contentGenerations: new Map(),
      toolPresentations: new Map(),
    });
    invokeMock.mockReset();
  });

  test("asks the backend for the measured text of each tool call's selected measurements", async () => {
    const handoffCalls: string[][] = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "changes_get_tool_presentations") {
        return {
          presentations: {
            "call-edit": presentation("call-edit", [
              "tool-effect/attempt/e/final",
              "tool-payload/attempt/e/final",
            ]),
            "call-shell": presentation("call-shell", ["observation-window/attempt/s/final"]),
            "call-unmeasured": presentation("call-unmeasured", ["tool-effect/attempt/u/final"]),
          },
          projections: {
            a: projection("tool-effect/attempt/e/final", "m-effect"),
            b: projection("tool-payload/attempt/e/final", "m-payload"),
            c: projection("observation-window/attempt/s/final", "m-shell"),
            d: projection("tool-effect/attempt/u/final", null),
          },
        };
      }
      if (command === "changes_get_handoff") {
        const ids = args.measurementIds as string[];
        handoffCalls.push(ids);
        return {
          kind: "handoff",
          text: `- measured ${ids.join(",")}: +unknown -2`,
          measurementIds: ids,
          truncated: false,
        };
      }
      return undefined;
    });

    const summaries = await resolveAgentHandoffChangeSummaries(SCOPE, messages);

    expect(handoffCalls).toContainEqual(["m-effect", "m-payload"]);
    expect(handoffCalls).toContainEqual(["m-shell"]);
    // No measurement, no request and no entry: the serializer writes "not measured".
    expect(handoffCalls).toHaveLength(2);
    expect(Object.keys(summaries).sort()).toEqual(["call-edit", "call-shell"]);

    const handoff = createAgentHandoffSnapshot({
      id: "h-1",
      environmentId: "env-1",
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "conv-1",
      messages,
      changeSummaries: summaries,
      now: "2026-10-20T11:00:00.000Z",
    });
    expect(handoff.bootstrapPrompt).toContain("measured m-effect,m-payload: +unknown -2");
    expect(handoff.bootstrapPrompt).toContain("measured m-shell");
    expect(handoff.bootstrapPrompt).toContain("changed: src/b.ts");
    expect(handoff.bootstrapPrompt).toContain("changes: not measured");
    expect(handoff.bootstrapPrompt).not.toContain("+0");
  });

  test("uses presentations already held by the store without re-reading them", async () => {
    const store = useChangeProjectionStore.getState();
    store.applyToolPresentations([
      [
        toolPresentationKey("env-1", "claude", "conv-1", "call-edit"),
        presentation("call-edit", ["k-1"]),
      ],
      [toolPresentationKey("env-1", "claude", "conv-1", "call-shell"), null],
      [toolPresentationKey("env-1", "claude", "conv-1", "call-unmeasured"), null],
    ]);
    store.applyProjection(projection("k-1", "m-1"));
    const commands: string[] = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      commands.push(command);
      if (command === "changes_get_handoff") {
        return {
          kind: "handoff",
          text: "- text",
          measurementIds: args.measurementIds,
          truncated: false,
        };
      }
      return undefined;
    });

    expect(await resolveAgentHandoffChangeSummaries(SCOPE, messages)).toEqual({
      "call-edit": "- text",
    });
    expect(commands).toEqual(["changes_get_handoff"]);
  });

  test("an older backend without change tracking yields no measured text", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("unknown command");
    });
    expect(await resolveAgentHandoffChangeSummaries(SCOPE, messages)).toEqual({});
  });

  test("V11: a partial/unknown measurement hands off the UI's measurement as backend text, never zero", async () => {
    const shown: ChangeProjection = {
      ...projection("tool-effect/attempt/e/final", "m-partial"),
      state: "partial",
      coverageState: "partial",
      counters: {
        additions: { value: 3, quality: "partial", bound: "none" },
        deletions: { value: null, quality: "unknown", bound: "none" },
        changedFiles: null,
      },
      reasonKeys: ["changes.reason.count-omitted"],
    };
    // What the transcript row renders for this projection.
    expect(formatLineCount("+", shown.counters.additions)).toBe("~+3");
    expect(formatLineCount("-", shown.counters.deletions)).toBe("-?");
    const store = useChangeProjectionStore.getState();
    store.applyToolPresentations([
      [
        toolPresentationKey("env-1", "claude", "conv-1", "call-edit"),
        presentation("call-edit", [shown.resourceKey]),
      ],
      [toolPresentationKey("env-1", "claude", "conv-1", "call-shell"), null],
      [toolPresentationKey("env-1", "claude", "conv-1", "call-unmeasured"), null],
    ]);
    store.applyProjection(shown);
    const backendText =
      "- tool change (observed in the workspace): +3 (partial) -unknown, files unknown\n  limits: count-omitted";
    const requested: unknown[] = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "changes_get_handoff") throw new Error(`unexpected ${command}`);
      requested.push(args.measurementIds);
      return { kind: "handoff", text: backendText, measurementIds: args.measurementIds };
    });

    const summaries = await resolveAgentHandoffChangeSummaries(SCOPE, messages);
    // The handoff serializes the very measurement the UI shows.
    expect(requested).toEqual([["m-partial"]]);
    expect(summaries["call-edit"]).toBe(backendText);
    const handoff = createAgentHandoffSnapshot({
      id: "h-2",
      environmentId: "env-1",
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: "conv-1",
      messages,
      changeSummaries: summaries,
      now: "2026-10-20T11:00:00.000Z",
    });
    expect(handoff.bootstrapPrompt).toContain("+3 (partial) -unknown, files unknown");
    expect(handoff.bootstrapPrompt).toContain("changes: not measured");
    expect(handoff.bootstrapPrompt).not.toMatch(/[+-]0\b/);
  });
});
