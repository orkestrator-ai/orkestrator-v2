import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type CanonicalToolPresentation,
  type ChangeFileRow,
  type ChangeProjection,
  type ChangesGetDiffResult,
} from "@orkestrator/protocol/change-resources";
import type { ToolKind } from "@orkestrator/protocol/change-evidence";
import { invoke } from "@/lib/native/backend";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import type { CreateFileTabOptions } from "@/contexts/TerminalContext";
import type { LegacyPayloadSummary } from "@/lib/backend/changes";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { NativeMessage } from "./NativeMessage";
import { resetChangePartCachesForTests } from "./NativeMessage.change-parts";
import { NativeChangeScopeContext, type NativeChangeScope } from "./NativeMessage.change-scope";

/*
 * Tool rows render backend change projections. The backend is reached only
 * through `invoke` (globally mocked in tests/setup.ts); each test answers the
 * `changes_*` commands it needs and asserts what the row shows from them.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

const SCOPE: NativeChangeScope = {
  environmentId: "env-1",
  provider: "claude",
  conversationId: "session-1",
};
const EFFECT_KEY = "tool-effect/operation/op-1/final/effect";
const PAYLOAD_KEY = "tool-payload/operation/op-1/final/payload";
const OBSERVATION_KEY = "observation-window/operation/op-1/final/observation";

const exact = (value: number): LineCount => ({ value, quality: "complete", bound: "exact" });
const unknown: LineCount = { value: null, quality: "unknown", bound: "none" };

function projection(
  resourceKey: string,
  overrides: Partial<ChangeProjection> = {},
): ChangeProjection {
  return {
    schemaVersion: 1,
    resourceKey,
    ownerGeneration: "gen-1",
    revision: 1,
    measurementId: `m:${resourceKey}`,
    state: "ready",
    availability: "ready",
    observationState: "fresh",
    coverageState: "complete",
    labelKey: "changes.scope.tool-effect",
    labelArgs: {},
    hasFileChanges: true,
    hasTextChanges: true,
    badge: { visible: true, mode: "counts" },
    counters: { additions: exact(3), deletions: exact(1), changedFiles: 1 },
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
    detail: { diffIdentityId: "diff-1" },
    filePage: null,
    actions: [],
    ...overrides,
  };
}

function fileRow(path: string, overrides: Partial<ChangeFileRow> = {}): ChangeFileRow {
  return {
    rowId: `row:${path}`,
    pathId: `path:${path}`,
    oldPathDisplay: path,
    newPathDisplay: path,
    status: "modified",
    fileKind: "text",
    additions: exact(2),
    deletions: exact(1),
    bodyAvailability: "available",
    reasonKey: null,
    detail: null,
    ...overrides,
  };
}

function presentation(
  toolKind: ToolKind,
  changes: CanonicalToolPresentation["changes"],
): CanonicalToolPresentation {
  return {
    schemaVersion: 1,
    operationId: "op-1",
    attemptId: "attempt-1",
    revision: 1,
    toolKind,
    lifecycle: { phase: "succeeded", executionOccurrence: "started" },
    changes,
  };
}

/** Answers presentation and view reads for one call. */
function serve(callId: string, value: CanonicalToolPresentation | null, views: ChangeProjection[]) {
  handlers.changes_get_tool_presentations = () => ({
    presentations: { [callId]: value },
    projections: Object.fromEntries(views.map((view) => [view.resourceKey, view])),
  });
  handlers.changes_get_view = (args) => {
    const view = views.find((candidate) => candidate.resourceKey === args.resourceKey);
    return view
      ? { kind: "projection", projection: view }
      : { kind: "deleted", resourceKey: args.resourceKey };
  };
}

function diffBody(text: string): ChangesGetDiffResult {
  return {
    kind: "body",
    identity: {
      id: "diff-1",
      kind: "comparison",
      beforeSnapshotId: "s1",
      afterSnapshotId: "s2",
      worktreeId: "w",
      worktreeIncarnation: "i",
      scope: "tool-effect",
      measurementId: "m",
      algorithmPolicyId: "raw-lines-v1",
      representationPolicyId: "raw-bytes-v1",
      rendererPolicyId: "r",
      whitespacePolicy: "preserve",
    },
    measurement: null,
    files: [
      {
        pathId: "path:src/app.ts",
        oldPathDisplay: "src/app.ts",
        newPathDisplay: "src/app.ts",
        status: "modified",
        fileKind: "text",
        bodyAvailability: "available",
        reasonKey: null,
        truncated: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", text: "old line", oldLine: 1, newLine: null },
              { type: "add", text: text, oldLine: null, newLine: 1 },
            ],
          },
        ],
      },
    ],
    nextCursor: null,
    viewIdentityId: "diff-1",
  };
}

function legacySummary(overrides: Partial<LegacyPayloadSummary> = {}): LegacyPayloadSummary {
  return {
    provenanceLabelKey: "changes.provenance.legacy-payload",
    additions: exact(7),
    deletions: exact(5),
    changedFiles: 1,
    contentLines: null,
    reasonKeys: [],
    files: [
      {
        pathId: "legacy:a",
        oldPathDisplay: "/workspace/src/a.ts",
        newPathDisplay: "/workspace/src/a.ts",
        status: "modified",
        fileKind: "text",
        bodyAvailability: "available",
        reasonKey: null,
        truncated: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", text: "backend before", oldLine: 1, newLine: null },
              { type: "add", text: "backend after", oldLine: null, newLine: 1 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function calls(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter((call: unknown[]) => call[0] === command)
    .map((call: unknown[]) => call[1] as Record<string, unknown>);
}

const openFile = mock((_path: string, _options?: CreateFileTabOptions) => undefined);

function RegisterFileTab() {
  const { setCreateFileTab } = useTerminalContext();
  useEffect(() => {
    setCreateFileTab(openFile);
    return () => setCreateFileTab(null);
  }, [setCreateFileTab]);
  return null;
}

function renderPart(part: NativeMessagePart, scope: NativeChangeScope | null = SCOPE) {
  const message = {
    id: `assistant-${part.toolUseId ?? "row"}`,
    role: "assistant" as const,
    content: "",
    createdAt: "2026-03-21T10:00:00.000Z",
    parts: [part],
  };
  const tree: ReactNode = (
    <TerminalProvider>
      <RegisterFileTab />
      <NativeMessage message={message} />
    </TerminalProvider>
  );
  return render(
    scope ? (
      <NativeChangeScopeContext.Provider value={scope}>{tree}</NativeChangeScopeContext.Provider>
    ) : (
      tree
    ),
  );
}

beforeEach(() => {
  handlers = {};
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) =>
    handlers[command]?.(args),
  );
  openFile.mockClear();
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
  resetChangeSubscriptionsForTests();
  resetChangePartCachesForTests();
  useChangeProjectionStore.setState({
    projections: new Map(),
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
  useMessagePartExpansionStore.getState().reset();
});

describe("tool rows with a backend presentation", () => {
  test("routes a file tool kind to the edit card without classifying the tool name", async () => {
    const effect = projection(EFFECT_KEY, {
      filePage: {
        snapshotToken: "t",
        rows: [fileRow("src/app.ts")],
        nextCursor: null,
        totalRows: 1,
      },
    });
    serve(
      "call-1",
      presentation("file-edit", [
        { role: "effect", resourceKey: EFFECT_KEY, prominence: "primary" },
      ]),
      [effect],
    );
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "mystery_tool",
      toolState: "success",
      toolUseId: "call-1",
    });

    // The edit card names the backend's file and shows its badge.
    expect(await screen.findByText("app.ts")).toBeTruthy();
    expect(screen.getByTestId("change-count-badge").textContent).toBe("+3-1");
    expect(calls("changes_get_tool_presentations")[0]).toMatchObject({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "session-1",
      callIds: ["call-1"],
    });
    // A presentation row never measures a legacy payload.
    expect(calls("changes_measure_legacy_payload")).toHaveLength(0);
  });

  test("keeps a shell tool kind on the generic tool row", async () => {
    serve("call-shell", presentation("shell", []), []);
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "Edit",
      toolState: "success",
      toolUseId: "call-shell",
    });
    await waitFor(() => expect(calls("changes_get_tool_presentations")).toHaveLength(1));
    // No diff payload and no file kind: the name "Edit" alone does not route.
    expect(screen.queryByText("Unknown file") === null).toBe(true);
    expect(document.querySelector(".lucide-pencil") === null).toBe(true);
  });

  test("renders backend count quality: unknown as +? and partial with ~", async () => {
    const effect = projection(EFFECT_KEY, {
      state: "partial",
      counters: {
        additions: unknown,
        deletions: { value: 4, quality: "partial", bound: "none" },
        changedFiles: 1,
      },
    });
    serve(
      "call-q",
      presentation("file-edit", [
        { role: "effect", resourceKey: EFFECT_KEY, prominence: "primary" },
      ]),
      [effect],
    );
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "Edit",
      toolState: "success",
      toolUseId: "call-q",
      toolDiff: { filePath: "/workspace/src/app.ts", before: "a\n", after: "b\n" },
    });

    const badge = await screen.findByTestId("change-count-badge");
    expect(badge.textContent).toBe("+?~-4");
    // Never measured locally or by the legacy adapter once a presentation exists.
    expect(calls("changes_measure_legacy_payload")).toHaveLength(0);
  });

  test("loads backend hunks only when expanded and keeps roles separate", async () => {
    const effect = projection(EFFECT_KEY);
    const payload = projection(PAYLOAD_KEY, {
      labelKey: "changes.scope.tool-payload",
      provenanceLabelKey: "changes.provenance.proposal",
      counters: { additions: exact(10), deletions: exact(0), changedFiles: 1 },
      detail: null,
    });
    serve(
      "call-body",
      presentation("file-edit", [
        { role: "payload", resourceKey: PAYLOAD_KEY, prominence: "secondary" },
        { role: "effect", resourceKey: EFFECT_KEY, prominence: "primary" },
      ]),
      [effect, payload],
    );
    handlers.changes_get_diff = () => diffBody("backend new line");
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "Edit",
      toolState: "success",
      toolUseId: "call-body",
      toolDiff: { filePath: "/workspace/src/app.ts", diff: "-a\n+b" },
    });

    // Collapsed: the primary (effect) role's badge, not a sum with the payload.
    const badge = await screen.findByTestId("change-count-badge");
    await waitFor(() => expect(badge.textContent).toBe("+3-1"));
    expect(calls("changes_get_diff")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /edit app\.ts/i }));
    expect(await screen.findByText("+backend new line")).toBeTruthy();
    expect(calls("changes_get_diff")).toEqual([{ diffIdentityId: "diff-1" }]);

    // Each role keeps its own label and badge, primary first.
    const roles = screen
      .getAllByTestId("change-role")
      .map((node) => node.getAttribute("data-change-role"));
    expect(roles).toEqual(["effect", "payload"]);
    expect(screen.getByText("Tool change")).toBeTruthy();
    expect(screen.getByText("Proposed / reported content")).toBeTruthy();
    expect(screen.getByTestId("change-role-badge-payload").textContent).toBe("+10-0");
    expect(document.body.textContent).not.toContain("+13");
  });

  test("shows an expired body as the backend's note, never today's file", async () => {
    serve(
      "call-exp",
      presentation("file-edit", [
        { role: "effect", resourceKey: EFFECT_KEY, prominence: "primary" },
      ]),
      [projection(EFFECT_KEY)],
    );
    handlers.changes_get_diff = () => ({
      kind: "error",
      error: { code: "body-expired", reasonKey: "changes.reason.body-expired" },
      identityId: "diff-1",
    });
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "Edit",
      toolState: "success",
      toolUseId: "call-exp",
      toolDiff: { filePath: "/workspace/src/app.ts", diff: "-a\n+b" },
    });
    await screen.findByTestId("change-count-badge");
    fireEvent.click(screen.getByRole("button", { name: /edit app\.ts/i }));
    expect(await screen.findByText(/body expired/i)).toBeTruthy();
    expect(openFile).not.toHaveBeenCalled();
  });

  test("pops out the historical identity and offers the current file as a separate action", async () => {
    serve(
      "call-pop",
      presentation("file-edit", [
        { role: "effect", resourceKey: EFFECT_KEY, prominence: "primary" },
      ]),
      [projection(EFFECT_KEY)],
    );
    handlers.changes_get_diff = () => diffBody("x");
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "Edit",
      toolState: "success",
      toolUseId: "call-pop",
      toolDiff: { filePath: "/workspace/src/app.ts", diff: "-a\n+b" },
    });
    await screen.findByTestId("change-count-badge");
    fireEvent.click(screen.getByRole("button", { name: /edit app\.ts/i }));

    fireEvent.click(await screen.findByTitle("Open diff in new tab"));
    expect(openFile).toHaveBeenLastCalledWith("/workspace/src/app.ts", {
      isDiff: true,
      changeDiff: { kind: "historical", diffIdentityId: "diff-1", title: "app.ts" },
    });

    fireEvent.click(screen.getByTitle("Open current file diff"));
    expect(openFile).toHaveBeenLastCalledWith("/workspace/src/app.ts", {
      isDiff: true,
      changeDiff: {
        kind: "live",
        resourceKey: environmentChangeResourceKey("env-1"),
        path: "/workspace/src/app.ts",
        title: "app.ts (current)",
      },
    });
    for (const call of openFile.mock.calls) {
      expect(call[1]).not.toHaveProperty("gitStatus");
    }
  });

  test("prefers a shell row's observation projection over the bridge measurement", async () => {
    const observation = projection(OBSERVATION_KEY, {
      labelKey: "changes.scope.observation-window",
      provenanceLabelKey: "changes.provenance.observed-after-start",
      detail: null,
      counters: { additions: exact(2), deletions: exact(1), changedFiles: 1 },
      filePage: {
        snapshotToken: "t",
        rows: [fileRow("src/a.ts", { pathId: "p-1", bodyAvailability: "not-retained" })],
        nextCursor: null,
        totalRows: 1,
      },
    });
    serve(
      "call-sh",
      presentation("shell", [
        { role: "observation", resourceKey: OBSERVATION_KEY, prominence: "primary" },
      ]),
      [observation],
    );
    renderPart({
      type: "tool-invocation",
      content: "",
      toolName: "Bash",
      toolState: "success",
      toolUseId: "call-sh",
      toolArgs: { command: "python3 rewrite.py" },
      commandChanges: {
        additions: 99,
        deletions: 99,
        files: [{ path: "src/a.ts", additions: 99, deletions: 99 }],
      },
    });

    const badge = await screen.findByTestId("change-count-badge");
    await waitFor(() => expect(badge.textContent).toBe("+2-1"));
    expect(screen.queryByTestId("command-change-stats") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Run Command python3 rewrite.py/i }));
    expect(screen.getByText("Workspace changes observed during this tool")).toBeTruthy();
    expect(screen.getByText("Observed in the workspace after the tool started")).toBeTruthy();
    expect(screen.getByText(/files open in their current state/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(openFile).toHaveBeenCalledWith("src/a.ts", {
      isDiff: true,
      changeDiff: {
        kind: "live",
        resourceKey: environmentChangeResourceKey("env-1"),
        pathId: "p-1",
        title: "src/a.ts (current)",
      },
    });
  });
});

describe("legacy edit rows", () => {
  const legacyPart: NativeMessagePart = {
    type: "tool-invocation",
    content: "",
    toolName: "Edit",
    toolState: "success",
    toolUseId: "old-call",
    toolOutput: "The file was updated",
    toolDiff: { filePath: "/workspace/src/a.ts", before: "one\ntwo\n", after: "three\n" },
  };

  test("measures the recorded payload on the backend and renders its counts and hunks", async () => {
    handlers.changes_measure_legacy_payload = () => legacySummary();
    renderPart(legacyPart, null);

    // The backend's numbers, which deliberately disagree with the sides: the
    // client must not compute its own.
    const badge = await screen.findByTestId("legacy-change-badge");
    expect(badge.textContent).toBe("+7-5");
    expect(badge.getAttribute("title")).toContain("Recorded tool input (measured by the backend)");
    expect(calls("changes_measure_legacy_payload")).toEqual([
      {
        toolName: "Edit",
        filePath: "/workspace/src/a.ts",
        before: "one\ntwo\n",
        after: "three\n",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /edit a\.ts/i }));
    expect(screen.getByText("+backend after")).toBeTruthy();
    expect(screen.getByText("-backend before")).toBeTruthy();
    expect(screen.queryByText("-one") === null).toBe(true);
    expect(screen.getByText("Recorded tool input (measured by the backend)")).toBeTruthy();
    // No identity: only the explicit current-file action is offered, and only with an environment.
    expect(screen.queryByTitle("Open diff in new tab") === null).toBe(true);
    expect(screen.queryByTitle("Open current file diff") === null).toBe(true);
    expect(calls("changes_measure_legacy_payload")).toHaveLength(1);
  });

  test("measures when the backend holds no presentation for the call", async () => {
    serve("old-call", null, []);
    handlers.changes_measure_legacy_payload = () => legacySummary();
    renderPart(legacyPart);
    expect((await screen.findByTestId("legacy-change-badge")).textContent).toBe("+7-5");
    fireEvent.click(screen.getByRole("button", { name: /edit a\.ts/i }));
    fireEvent.click(screen.getByTitle("Open current file diff"));
    expect(openFile).toHaveBeenCalledWith("/workspace/src/a.ts", {
      isDiff: true,
      changeDiff: {
        kind: "live",
        resourceKey: environmentChangeResourceKey("env-1"),
        path: "/workspace/src/a.ts",
        title: "a.ts (current)",
      },
    });
  });

  test("shows the path and raw output without numbers when measurement fails", async () => {
    handlers.changes_measure_legacy_payload = () => {
      throw new Error("unknown command");
    };
    renderPart(legacyPart, null);
    await waitFor(() => expect(calls("changes_measure_legacy_payload")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /edit a\.ts/i }));
    expect(await screen.findByText("The file was updated")).toBeTruthy();
    expect(screen.getByText("/workspace/src/a.ts")).toBeTruthy();
    expect(screen.queryByTestId("legacy-change-badge") === null).toBe(true);
    expect(screen.queryByText(/^[+-]\d/) === null).toBe(true);
  });

  test("shows content lines when the backend cannot count a write against unknown prior state", async () => {
    handlers.changes_measure_legacy_payload = () =>
      legacySummary({ additions: unknown, deletions: unknown, contentLines: 12 });
    renderPart(
      {
        ...legacyPart,
        toolName: "Write",
        toolDiff: { filePath: "/workspace/src/a.ts", after: "x" },
      },
      null,
    );
    expect((await screen.findByTestId("legacy-change-badge")).textContent).toBe("12 lines");
  });
});
