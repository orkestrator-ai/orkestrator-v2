import { afterAll, afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { exactCount, type ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangeDiffLine,
  type ChangesGetDiffResult,
  type ChangesResolveLiveDetailResult,
  type DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import { invoke } from "@/lib/native/backend";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { DiffViewerTab } from "./DiffViewerTab";

type InvokeArgs = Record<string, unknown> | undefined;
type CommandHandler = (args: InvokeArgs) => unknown;

const invokeMock = invoke as unknown as Mock<
  (command: string, args?: InvokeArgs) => Promise<unknown>
>;
let handlers: Record<string, CommandHandler> = {};

const RESOURCE_KEY = environmentChangeResourceKey("env-1");
const originalMatchMedia = window.matchMedia;
let viewportWidth = 1024;
const mediaQueryListeners = new Set<() => void>();

function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === "(max-width: 767px)" && viewportWidth <= 767;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") mediaQueryListeners.add(listener as () => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") mediaQueryListeners.delete(listener as () => void);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
}

function setViewportWidth(width: number) {
  act(() => {
    viewportWidth = width;
    for (const listener of mediaQueryListeners) listener();
  });
}

function measurement(overrides: Partial<ChangeMeasurement> = {}): ChangeMeasurement {
  return {
    schemaVersion: 1,
    measurementId: "m-1",
    worktreeId: "wt-1",
    worktreeIncarnation: "inc-1",
    scope: "thread-net",
    logicalOwner: {},
    baselineVersion: null,
    beforeSnapshotId: "snap-a",
    afterSnapshotId: "snap-b",
    evidenceRefs: [],
    capabilityRevision: null,
    origin: "captured-endpoints",
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "raw-bytes-v1",
    execution: "not-applicable",
    executionOccurrence: "not-applicable",
    effectClaim: "workspace-observed",
    finality: "final",
    consistency: "stable-observation",
    boundary: { before: "fresh-before", after: "after-terminal" },
    attribution: { basis: "workspace-observation", writerIsolation: "unknown", overlap: "unknown" },
    completeness: { files: "complete", reasons: [], omittedFileCount: 0 },
    totals: { additions: exactCount(7), deletions: exactCount(2), changedFiles: 1 },
    diffIdentityId: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    supersedesMeasurementId: null,
    ...overrides,
  };
}

function fileIdentity(
  id: string,
  options: { before?: string | null; after?: string | null; scope?: DiffIdentity["scope"] } = {},
): DiffIdentity {
  const before = options.before === undefined ? "src/app.ts" : options.before;
  const after = options.after === undefined ? "src/app.ts" : options.after;
  return {
    id,
    worktreeId: "wt-1",
    worktreeIncarnation: "inc-1",
    scope: options.scope ?? "thread-net",
    measurementId: `m-${id}`,
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "raw-bytes-v1",
    rendererPolicyId: "hunks-v1",
    whitespacePolicy: "preserve",
    kind: "file",
    before: before
      ? { state: "present", snapshotId: "snap-a", pathId: `p:${before}`, blobId: "blob-a" }
      : { state: "absent" },
    after: after
      ? { state: "present", snapshotId: "snap-b", pathId: `p:${after}`, blobId: "blob-b" }
      : { state: "absent" },
    basePathDisplay: before,
    targetPathDisplay: after,
  };
}

function comparisonIdentity(id: string): DiffIdentity {
  return {
    id,
    worktreeId: "wt-1",
    worktreeIncarnation: "inc-1",
    scope: "turn-net",
    measurementId: `m-${id}`,
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "raw-bytes-v1",
    rendererPolicyId: "hunks-v1",
    whitespacePolicy: "preserve",
    kind: "comparison",
    beforeSnapshotId: "snap-a",
    afterSnapshotId: "snap-b",
  };
}

function line(type: ChangeDiffLine["type"], text: string): ChangeDiffLine {
  return { type, text, oldLine: null, newLine: null };
}

function fileBody(
  path: string,
  lines: ChangeDiffLine[],
  overrides: Partial<ChangeDiffFileBody> = {},
): ChangeDiffFileBody {
  return {
    pathId: `p:${path}`,
    oldPathDisplay: path,
    newPathDisplay: path,
    status: "modified",
    fileKind: "text",
    bodyAvailability: "available",
    reasonKey: null,
    hunks: [
      { header: "@@ -1,2 +1,2 @@", oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines },
    ],
    truncated: false,
    ...overrides,
  };
}

function diffBody(
  identity: DiffIdentity,
  files: ChangeDiffFileBody[],
  options: { measurement?: ChangeMeasurement | null; nextCursor?: string | null } = {},
): ChangesGetDiffResult {
  return {
    kind: "body",
    identity,
    measurement: options.measurement === undefined ? measurement() : options.measurement,
    files,
    nextCursor: options.nextCursor ?? null,
    viewIdentityId: identity.id,
  };
}

function calls(command: string): InvokeArgs[] {
  return invokeMock.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const historical: ChangeDiffTarget = {
  kind: "historical",
  diffIdentityId: "diff-h",
  title: "app.ts",
};
const live: ChangeDiffTarget = {
  kind: "live",
  resourceKey: RESOURCE_KEY,
  path: "src/app.ts",
  title: "app.ts",
};

beforeEach(() => {
  viewportWidth = 1024;
  mediaQueryListeners.clear();
  installMatchMedia();
  resetChangeSubscriptionsForTests();
  useChangeProjectionStore.setState({
    projections: new Map(),
    retiredOwners: new Map(),
    transportRevision: 0,
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
  handlers = {
    // The shared subscription reads the environment projection; the viewer
    // does not depend on it.
    changes_get_view: () => ({
      kind: "error",
      error: { code: "unsupported-capability", reasonKey: "changes.error.unsupported" },
    }),
  };
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args?: InvokeArgs) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`Unexpected command: ${command}`);
    return handler(args);
  });
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
  invokeMock.mockImplementation(() => Promise.resolve());
});

/** Every backend call the viewer made; it never reads a file or a branch. */
function expectOnlyChangeCommands() {
  for (const [command] of invokeMock.mock.calls) expect(command.startsWith("changes_")).toBe(true);
}

describe("DiffViewerTab historical targets", () => {
  test("renders the backend hunks of exactly the named identity", async () => {
    const identity = fileIdentity("diff-h");
    handlers.changes_get_diff = () =>
      diffBody(identity, [
        fileBody("src/app.ts", [
          line("context", "keep"),
          line("remove", "old"),
          line("add", "new"),
        ]),
      ]);

    render(<DiffViewerTab target={historical} isActive />);

    expect(await screen.findByText("+new")).toBeTruthy();
    expect(screen.getByText("-old")).toBeTruthy();
    expect(calls("changes_get_diff")).toEqual([{ diffIdentityId: "diff-h" }]);
    expect(calls("changes_resolve_live_detail")).toHaveLength(0);
    expectOnlyChangeCommands();

    expect(screen.getByTestId("diff-viewer-scope").textContent).toBe("Thread changes");
    expect(screen.getByTestId("diff-viewer-endpoints").textContent).toBe("Before → After");
    expect(screen.getByTestId("diff-viewer-counts").textContent).toBe("+7 -2");
    expect(screen.getByText("Modified")).toBeTruthy();
    // A historical diff is fixed: no reload and no jump to today's file.
    expect(screen.queryByRole("button", { name: "Reload diff" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "View file" }) === null).toBe(true);
  });

  test("labels renames with both paths and the resolved baseline", async () => {
    const identity = fileIdentity("diff-h", { before: "src/old.ts", after: "src/new.ts" });
    handlers.changes_get_diff = () =>
      diffBody(
        identity,
        [
          fileBody("src/new.ts", [line("add", "x")], {
            oldPathDisplay: "src/old.ts",
            status: "renamed",
          }),
        ],
        {
          measurement: measurement({
            scope: "environment-net",
            baselineVersion: "main@63d12576e9198f24bc2271a6a8c3702dfb391eae",
          }),
        },
      );

    render(<DiffViewerTab target={historical} isActive />);

    await screen.findByText("+x");
    expect(screen.getByText("src/old.ts renamed to src/new.ts")).toBeTruthy();
    expect(screen.getByText("Renamed")).toBeTruthy();
    expect(screen.getByTestId("diff-viewer-scope").textContent).toBe("Environment changes");
    const endpoints = screen.getByTestId("diff-viewer-endpoints");
    expect(endpoints.textContent).toBe("main@63d1257 → After");
    expect(endpoints.getAttribute("title")).toBe(
      "main@63d12576e9198f24bc2271a6a8c3702dfb391eae → After",
    );
  });

  test("shows an expired body as unavailable and never falls back to disk", async () => {
    handlers.changes_get_diff = () => ({
      kind: "error",
      error: { code: "body-expired", reasonKey: "changes.error.body-expired" },
      identityId: "diff-h",
    });

    render(<DiffViewerTab target={historical} filePath="src/app.ts" isActive />);

    expect(await screen.findByText("This diff is no longer available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" }) === null).toBe(true);
    expect(calls("changes_get_diff")).toHaveLength(1);
    expectOnlyChangeCommands();
  });

  test("shows an unknown identity as not found", async () => {
    handlers.changes_get_diff = () => ({
      kind: "error",
      error: { code: "not-found", reasonKey: "changes.error.not-found" },
      identityId: "diff-h",
    });

    render(<DiffViewerTab target={historical} isActive />);

    expect(await screen.findByText("This diff could not be found")).toBeTruthy();
  });

  test("retries a failed request for the same identity", async () => {
    let attempt = 0;
    handlers.changes_get_diff = () => {
      attempt += 1;
      if (attempt === 1) throw new Error("gateway offline");
      return diffBody(fileIdentity("diff-h"), [fileBody("src/app.ts", [line("add", "back")])]);
    };

    render(<DiffViewerTab target={historical} isActive />);

    expect(await screen.findByText("gateway offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("+back")).toBeTruthy();
    expect(calls("changes_get_diff")).toEqual([
      { diffIdentityId: "diff-h" },
      { diffIdentityId: "diff-h" },
    ]);
  });

  test("pages a multi-file comparison with Load more files", async () => {
    const identity = comparisonIdentity("diff-h");
    const totals = measurement({
      scope: "turn-net",
      totals: { additions: exactCount(12), deletions: exactCount(3), changedFiles: 2 },
    });
    handlers.changes_get_diff = (args) =>
      args?.cursor === "1"
        ? diffBody(identity, [fileBody("b.ts", [line("add", "second")])], { measurement: totals })
        : diffBody(identity, [fileBody("a.ts", [line("add", "first")])], {
            measurement: totals,
            nextCursor: "1",
          });

    render(<DiffViewerTab target={{ ...historical, title: "Turn 3" }} isActive />);

    expect(await screen.findByText("+first")).toBeTruthy();
    expect(screen.getByRole("region", { name: "a.ts" })).toBeTruthy();
    expect(screen.getByTestId("diff-viewer-counts").textContent).toBe("2 files+12 -3");
    expect(screen.queryByText("+second") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Load more files" }));

    expect(await screen.findByText("+second")).toBeTruthy();
    expect(screen.getByText("+first")).toBeTruthy();
    expect(calls("changes_get_diff")).toEqual([
      { diffIdentityId: "diff-h" },
      { diffIdentityId: "diff-h", cursor: "1" },
    ]);
    expect(screen.queryByRole("button", { name: "Load more files" }) === null).toBe(true);
    expect(screen.getByTestId("diff-viewer-counts").textContent).toBe("2 files+12 -3");
  });

  test("requests the whitespace view without changing the canonical counts", async () => {
    const identity = fileIdentity("diff-h");
    handlers.changes_get_diff = (args) => {
      const display = args?.display as { whitespace?: string } | undefined;
      return display?.whitespace === "ignore-for-view"
        ? {
            ...diffBody(identity, [fileBody("src/app.ts", [line("add", "real change")])]),
            viewIdentityId: "diff-h:ws-ignore",
          }
        : diffBody(identity, [
            fileBody("src/app.ts", [
              line("remove", "indented-old"),
              line("add", "indented-new"),
              line("add", "real change"),
            ]),
          ]);
    };

    render(<DiffViewerTab target={historical} isActive />);

    expect(await screen.findByText("+indented-new")).toBeTruthy();
    expect(screen.getByTestId("diff-viewer-counts").textContent).toBe("+7 -2");

    const toggle = screen.getByRole("button", { name: "Hide whitespace changes" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.queryByText("+indented-new") === null).toBe(true));
    expect(screen.getByText("+real change")).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(calls("changes_get_diff")).toEqual([
      { diffIdentityId: "diff-h" },
      { diffIdentityId: "diff-h", display: { whitespace: "ignore-for-view" } },
    ]);
    // The header still shows the measurement's totals, not the visible rows.
    expect(screen.getByTestId("diff-viewer-counts").textContent).toBe("+7 -2");
  });

  test("lays the same rows out side by side or inline", async () => {
    handlers.changes_get_diff = () =>
      diffBody(fileIdentity("diff-h"), [
        fileBody("src/app.ts", [line("remove", "old"), line("add", "new")]),
      ]);

    const { container } = render(<DiffViewerTab target={historical} isActive />);

    await screen.findByText("+new");
    const sideBySide = screen.getByRole("button", { name: "Side by side" });
    const inline = screen.getByRole("button", { name: "Inline" });
    expect(sideBySide.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("pre") === null).toBe(true);

    fireEvent.click(inline);
    expect(inline.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("pre")).not.toBeNull();
    expect(calls("changes_get_diff")).toHaveLength(1);
  });

  test("hides an inactive view without dropping its content", async () => {
    handlers.changes_get_diff = () =>
      diffBody(fileIdentity("diff-h"), [fileBody("src/app.ts", [line("add", "kept")])]);

    render(<DiffViewerTab target={historical} isActive={false} />);

    expect(await screen.findByText("+kept")).toBeTruthy();
    expect(screen.getByTestId("diff-viewer").className).toContain("opacity-0");
    expect(screen.getByTestId("diff-viewer").className).toContain("pointer-events-none");
  });
});

describe("DiffViewerTab live targets", () => {
  function liveHandlers() {
    let resolveCount = 0;
    handlers.changes_resolve_live_detail = () => {
      resolveCount += 1;
      return {
        kind: "identity",
        identity: fileIdentity(`diff-live-${resolveCount}`, { scope: "environment-net" }),
      } satisfies ChangesResolveLiveDetailResult;
    };
    handlers.changes_get_diff = (args) =>
      diffBody(
        fileIdentity(String(args?.diffIdentityId), { scope: "environment-net" }),
        [fileBody("src/app.ts", [line("add", `body of ${String(args?.diffIdentityId)}`)])],
        {
          measurement: measurement({
            scope: "environment-net",
            baselineVersion: "main@63d12576e9198f24bc2271a6a8c3702dfb391eae",
            finality: "provisional",
          }),
        },
      );
  }

  test("resolves the current file to an identity and labels it as the workspace file", async () => {
    liveHandlers();
    const onSwitchToFileView = mock(() => {});

    render(<DiffViewerTab target={live} isActive onSwitchToFileView={onSwitchToFileView} />);

    expect(await screen.findByText("+body of diff-live-1")).toBeTruthy();
    expect(calls("changes_resolve_live_detail")).toEqual([
      { resourceKey: RESOURCE_KEY, path: "src/app.ts" },
    ]);
    expect(calls("changes_get_diff")).toEqual([{ diffIdentityId: "diff-live-1" }]);
    expect(screen.getByTestId("diff-viewer-endpoints").textContent).toBe(
      "vs main@63d1257 · Current workspace file",
    );
    expect(screen.getByTestId("diff-viewer-endpoints").getAttribute("title")).toBe(
      "main@63d12576e9198f24bc2271a6a8c3702dfb391eae → Current workspace file",
    );
    expectOnlyChangeCommands();

    fireEvent.click(screen.getByRole("button", { name: "View file" }));
    expect(onSwitchToFileView).toHaveBeenCalledTimes(1);
  });

  test("reconnect and returning from an inactive environment resolve missed same-count edits", async () => {
    liveHandlers();
    const view = render(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+body of diff-live-1");
    act(() => useChangeProjectionStore.getState().resync());
    await screen.findByText("+body of diff-live-2");
    view.rerender(<DiffViewerTab target={live} isActive={false} />);
    act(() => useChangeProjectionStore.getState().resync());
    view.rerender(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+body of diff-live-3");
  });

  test("hosts without change tracking show an explicit unsupported state", async () => {
    handlers.changes_resolve_live_detail = () => {
      throw new Error("unknown command");
    };
    render(<DiffViewerTab target={live} isActive />);
    expect(await screen.findByText(/This host does not support change diffs/)).toBeTruthy();
  });

  test("re-resolves when the content generation names this file, and only then", async () => {
    liveHandlers();
    render(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+body of diff-live-1");

    // Another file changed: nothing to do.
    act(() => {
      useChangeProjectionStore.getState().applyContentInvalidation(RESOURCE_KEY, 1, ["p:other.ts"]);
    });
    await act(async () => {});
    expect(calls("changes_resolve_live_detail")).toHaveLength(1);

    // This file changed: a new identity, resolved by the path id the backend named.
    act(() => {
      useChangeProjectionStore
        .getState()
        .applyContentInvalidation(RESOURCE_KEY, 2, ["p:other.ts", "p:src/app.ts"]);
    });
    expect(await screen.findByText("+body of diff-live-2")).toBeTruthy();
    expect(calls("changes_resolve_live_detail")[1]).toEqual({
      resourceKey: RESOURCE_KEY,
      pathId: "p:src/app.ts",
    });

    // Every path may have changed.
    act(() => {
      useChangeProjectionStore.getState().applyContentInvalidation(RESOURCE_KEY, 3, null);
    });
    expect(await screen.findByText("+body of diff-live-3")).toBeTruthy();
    expect(calls("changes_get_diff").map((args) => args?.diffIdentityId)).toEqual([
      "diff-live-1",
      "diff-live-2",
      "diff-live-3",
    ]);
  });

  test("ignores invalidations of another resource", async () => {
    liveHandlers();
    render(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+body of diff-live-1");

    act(() => {
      useChangeProjectionStore
        .getState()
        .applyContentInvalidation(environmentChangeResourceKey("env-2"), 5, null);
    });
    await act(async () => {});
    expect(calls("changes_resolve_live_detail")).toHaveLength(1);
  });

  test("reloads on request", async () => {
    liveHandlers();
    render(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+body of diff-live-1");

    fireEvent.click(screen.getByRole("button", { name: "Reload diff" }));

    expect(await screen.findByText("+body of diff-live-2")).toBeTruthy();
  });

  test("retries a stale revision without the pinned row", async () => {
    handlers.changes_resolve_live_detail = (args) =>
      args?.revision !== undefined
        ? {
            kind: "error",
            error: { code: "stale-revision", reasonKey: "changes.error.stale-revision" },
          }
        : { kind: "identity", identity: fileIdentity("diff-fresh", { scope: "environment-net" }) };
    handlers.changes_get_diff = () =>
      diffBody(fileIdentity("diff-fresh"), [fileBody("src/app.ts", [line("add", "fresh")])]);

    render(
      <DiffViewerTab
        target={{ ...live, path: undefined, pathId: "p:src/app.ts", rowId: "m-0:3", revision: 4 }}
        isActive
      />,
    );

    expect(await screen.findByText("+fresh")).toBeTruthy();
    expect(calls("changes_resolve_live_detail")).toEqual([
      { resourceKey: RESOURCE_KEY, pathId: "p:src/app.ts", rowId: "m-0:3", revision: 4 },
      { resourceKey: RESOURCE_KEY, pathId: "p:src/app.ts" },
    ]);
  });

  test("shows a stale row it cannot follow as unavailable", async () => {
    handlers.changes_resolve_live_detail = () => ({
      kind: "error",
      error: { code: "stale-revision", reasonKey: "changes.error.stale-revision" },
    });

    render(
      <DiffViewerTab
        target={{
          kind: "live",
          resourceKey: RESOURCE_KEY,
          rowId: "m-0:3",
          revision: 4,
          title: "x",
        }}
        isActive
      />,
    );

    expect(await screen.findByText("The change list moved on")).toBeTruthy();
    expect(calls("changes_resolve_live_detail")).toHaveLength(1);
    expect(calls("changes_get_diff")).toHaveLength(0);
  });

  test("reports a resolve failure and retries", async () => {
    let attempt = 0;
    handlers.changes_resolve_live_detail = () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          kind: "error",
          error: { code: "unsupported-capability", reasonKey: "changes.error.runtime-unavailable" },
        };
      }
      return { kind: "identity", identity: fileIdentity("diff-ok", { scope: "environment-net" }) };
    };
    handlers.changes_get_diff = () =>
      diffBody(fileIdentity("diff-ok"), [fileBody("src/app.ts", [line("add", "ok")])]);

    render(<DiffViewerTab target={live} isActive />);

    expect(await screen.findByText("Diff unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("+ok")).toBeTruthy();
  });

  test("drops an older resolve that finishes after a newer one", async () => {
    const first = deferred<ChangesResolveLiveDetailResult>();
    let resolveCount = 0;
    handlers.changes_resolve_live_detail = () => {
      resolveCount += 1;
      if (resolveCount === 1) return first.promise;
      return { kind: "identity", identity: fileIdentity("diff-new") };
    };
    handlers.changes_get_diff = (args) =>
      diffBody(fileIdentity(String(args?.diffIdentityId)), [
        fileBody("src/app.ts", [line("add", String(args?.diffIdentityId))]),
      ]);

    render(<DiffViewerTab target={live} isActive />);
    await waitFor(() => expect(calls("changes_resolve_live_detail")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Reload diff" }));

    expect(await screen.findByText("+diff-new")).toBeTruthy();
    await act(async () => {
      first.resolve({ kind: "identity", identity: fileIdentity("diff-old") });
      await first.promise;
    });
    expect(screen.getByText("+diff-new")).toBeTruthy();
    expect(calls("changes_get_diff").map((args) => args?.diffIdentityId)).toEqual(["diff-new"]);
  });
});

describe("DiffViewerTab on a mobile viewport", () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  test("pins the inline layout, hides the mode toggle and shows only the basename", async () => {
    handlers.changes_get_diff = () =>
      diffBody(fileIdentity("diff-h", { before: null, after: "src/components/Button.tsx" }), [
        fileBody("src/components/Button.tsx", [line("add", "button")], { status: "added" }),
      ]);

    const { container } = render(<DiffViewerTab target={historical} isActive />);

    await screen.findByText("+button");
    expect(screen.queryByRole("button", { name: "Side by side" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Inline" }) === null).toBe(true);
    expect(container.querySelector("pre")).not.toBeNull();

    const path = screen.getByTitle("src/components/Button.tsx");
    expect(path.querySelector(".sr-only")?.textContent).toBe("src/components/Button.tsx");
    expect(path.querySelector('[aria-hidden="true"]')?.textContent).toBe("Button.tsx");
    // The status stays available to assistive technology.
    expect(screen.getByText("New file").className).toContain("sr-only");
  });

  test("restores the remembered desktop layout when the viewport widens", async () => {
    handlers.changes_get_diff = () =>
      diffBody(fileIdentity("diff-h"), [fileBody("src/app.ts", [line("add", "x")])]);

    const { container } = render(<DiffViewerTab target={historical} isActive />);
    await screen.findByText("+x");
    expect(container.querySelector("pre")).not.toBeNull();

    setViewportWidth(1024);
    expect(screen.getByRole("button", { name: "Side by side" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.querySelector("pre") === null).toBe(true);
  });
});
