import { afterAll, afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within, act } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  changeResourceKey,
  environmentChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangeDiffHunk,
  type ChangesGetDiffResult,
  type DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import { invoke } from "@/lib/native/backend";
import { resetChangeTrackingCapabilitiesForTests } from "@/lib/backend/changes";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { changeProjectionStore } from "@/stores/changeProjectionStore";
import { appCommandStore } from "@/test/app-command-store";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { DiffViewerTab } from "./DiffViewerTab";

/**
 * Hunk and file navigation, and selective staging, in the diff tab. The
 * backend owns staging: these tests check what the tab sends and how it
 * reports each answer, never a local index.
 */

type InvokeArgs = Record<string, unknown> | undefined;
type CommandHandler = (args: InvokeArgs) => unknown;

const invokeMock = invoke as unknown as Mock<
  (command: string, args?: InvokeArgs) => Promise<unknown>
>;
let handlers: Record<string, CommandHandler> = {};

const ENV_KEY = environmentChangeResourceKey("env-1");
const UNSTAGED_KEY = changeResourceKey({
  scope: "unstaged",
  ownerKind: "environment",
  ownerId: "env-1",
  selector: "live",
});
const STAGED_KEY = changeResourceKey({
  scope: "staged",
  ownerKind: "environment",
  ownerId: "env-1",
  selector: "live",
});

const live: ChangeDiffTarget = {
  kind: "live",
  resourceKey: ENV_KEY,
  pathId: "u:src/app.ts",
  title: "app.ts",
};

function identity(id: string, scope: DiffIdentity["scope"]): DiffIdentity {
  return {
    id,
    worktreeId: "wt-1",
    worktreeIncarnation: "inc-1",
    scope,
    measurementId: `m-${id}`,
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "git-index-vs-worktree-bytes-v1",
    rendererPolicyId: "hunks-v1",
    whitespacePolicy: "preserve",
    kind: "file",
    before: { state: "present", snapshotId: "a", pathId: "u:src/app.ts", blobId: "blob-a" },
    after: { state: "present", snapshotId: "b", pathId: "u:src/app.ts", blobId: "blob-b" },
    basePathDisplay: "src/app.ts",
    targetPathDisplay: "src/app.ts",
  };
}

function hunk(start: number, text: string): ChangeDiffHunk {
  return {
    header: `@@ -${start},1 +${start},1 @@`,
    oldStart: start,
    oldLines: 1,
    newStart: start,
    newLines: 1,
    lines: [
      { type: "remove", text: `old ${text}`, oldLine: start, newLine: null },
      { type: "add", text: `new ${text}`, oldLine: null, newLine: start },
    ],
  };
}

function file(path: string, hunks: ChangeDiffHunk[]): ChangeDiffFileBody {
  return {
    pathId: `u:${path}`,
    oldPathDisplay: path,
    newPathDisplay: path,
    status: "modified",
    fileKind: "text",
    bodyAvailability: "available",
    reasonKey: null,
    hunks,
    truncated: false,
  };
}

function body(diffIdentity: DiffIdentity, files: ChangeDiffFileBody[]): ChangesGetDiffResult {
  return {
    kind: "body",
    identity: diffIdentity,
    measurement: null,
    files,
    nextCursor: null,
    viewIdentityId: diffIdentity.id,
  };
}

function calls(command: string): InvokeArgs[] {
  return invokeMock.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
}

/** A live file whose diff has `count` hunks; each resolve mints a new identity. */
function liveFile(count: number, scopeFor = (resourceKey: string) => resourceKey) {
  let resolves = 0;
  const hunksById = new Map<string, ChangeDiffHunk[]>();
  handlers.changes_resolve_live_detail = (args) => {
    resolves += 1;
    const resourceKey = scopeFor(String(args?.resourceKey));
    const scope =
      resourceKey === STAGED_KEY
        ? "staged"
        : resourceKey === UNSTAGED_KEY
          ? "unstaged"
          : "environment-net";
    const id = `diff-${scope}-${resolves}`;
    hunksById.set(
      id,
      Array.from({ length: count }, (_, index) => hunk(index * 10 + 1, `${index + 1}`)),
    );
    return { kind: "identity", identity: identity(id, scope) };
  };
  handlers.changes_get_diff = (args) => {
    const id = String(args?.diffIdentityId);
    const scope = id.startsWith("diff-staged")
      ? "staged"
      : id.startsWith("diff-unstaged")
        ? "unstaged"
        : "environment-net";
    return body(identity(id, scope), [file("src/app.ts", hunksById.get(id) ?? [])]);
  };
  return { hunksById, setCount: (next: number) => (count = next) };
}

beforeEach(() => {
  resetChangeSubscriptionsForTests();
  resetChangeTrackingCapabilitiesForTests();
  appCommandStore(changeProjectionStore).setState({
    projections: new Map(),
    retiredOwners: new Map(),
    transportRevision: 0,
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
  handlers = {
    changes_get_view: () => ({
      kind: "error",
      error: { code: "unsupported-capability", reasonKey: "changes.error.unsupported" },
    }),
    changes_get_capabilities: () => ({
      capability: "change-tracking-v1",
      policyVersion: "1",
      history: true,
      restore: true,
      gitScopes: true,
      operationVolume: true,
      strictCheckpoints: false,
      hunkStaging: true,
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
  resetChangeTrackingCapabilitiesForTests();
});

afterAll(() => {
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("DiffViewerTab hunk navigation", () => {
  test("counts changes and steps through them with buttons and keys", async () => {
    liveFile(3);
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+new 1");
    const counter = screen.getByTestId("diff-viewer-hunk-position");
    expect(counter.textContent).toBe("Change 1 of 3");
    const headers = () => screen.getAllByTestId("change-hunk-header");
    expect(headers()[0]!.getAttribute("aria-current")).toBe("location");

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(counter.textContent).toBe("Change 2 of 3");
    expect(headers()[1]!.getAttribute("aria-current")).toBe("location");
    expect(headers()[0]!.getAttribute("aria-current")).toBeNull();

    const viewer = screen.getByTestId("diff-viewer");
    fireEvent.keyDown(viewer, { key: "]" });
    expect(counter.textContent).toBe("Change 3 of 3");
    expect(
      (screen.getByRole("button", { name: "Next change" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(viewer, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(viewer, { key: "[" });
    expect(counter.textContent).toBe("Change 1 of 3");
    // Shortcuts are announced on the controls.
    expect(
      screen.getByRole("button", { name: "Previous change" }).getAttribute("aria-keyshortcuts"),
    ).toBe("[ Alt+ArrowUp");

    // Clicking a hunk selects it; keys typed into a field are not navigation.
    fireEvent.click(headers()[2]!);
    expect(counter.textContent).toBe("Change 3 of 3");
    const input = document.createElement("input");
    viewer.appendChild(input);
    fireEvent.keyDown(input, { key: "[" });
    expect(counter.textContent).toBe("Change 3 of 3");
  });

  test("moves between files of a multi-file body", async () => {
    const comparison: DiffIdentity = {
      ...identity("diff-h", "turn-net"),
      kind: "comparison",
      beforeSnapshotId: "a",
      afterSnapshotId: "b",
    } as DiffIdentity;
    handlers.changes_get_diff = () =>
      body(comparison, [
        file("a.ts", [hunk(1, "a1"), hunk(20, "a2")]),
        file("bin.dat", []),
        file("c.ts", [hunk(5, "c1")]),
      ]);
    renderInAppCommandScope(
      <DiffViewerTab
        target={{ kind: "historical", diffIdentityId: "diff-h", title: "t" }}
        isActive
      />,
    );
    await screen.findByText("+new a1");
    const filePosition = () => screen.getByTestId("diff-viewer-file-position").textContent;
    const counter = () => screen.getByTestId("diff-viewer-hunk-position").textContent;
    expect(filePosition()).toBe("File 1 of 3");
    expect(counter()).toBe("Change 1 of 3");

    // The binary file has no hunk to land on, so the next file is c.ts.
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(filePosition()).toBe("File 3 of 3");
    expect(counter()).toBe("Change 3 of 3");
    fireEvent.keyDown(screen.getByTestId("diff-viewer"), { key: "{" });
    expect(filePosition()).toBe("File 1 of 3");
    expect(counter()).toBe("Change 1 of 3");
    // A historical body offers no staging.
    expect(screen.queryByRole("button", { name: /^Stage change/ }) === null).toBe(true);
  });
});

describe("DiffViewerTab selective staging", () => {
  test("stages exactly the reviewed hunk, then shows a fresh diff", async () => {
    const live$ = liveFile(2);
    handlers.changes_stage_hunk = () => {
      live$.setCount(1);
      return { kind: "applied", action: "stage", pathId: "u:src/app.ts" };
    };
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+new 2");

    fireEvent.click(screen.getByRole("button", { name: "Stage change 2" }));
    expect(await screen.findByTestId("diff-viewer-staging-feedback")).toBeTruthy();
    expect(calls("changes_stage_hunk")).toEqual([
      {
        diffIdentityId: "diff-environment-net-1",
        action: "stage",
        hunk: { index: 1, oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 },
      },
    ]);
    const feedback = screen.getByTestId("diff-viewer-staging-feedback");
    expect(feedback.getAttribute("role")).toBe("status");
    expect(feedback.textContent).toContain("Staged change 2.");
    // The all-changes view does not compare against the index; it says so.
    expect(feedback.textContent).toContain("switch to Staged");
    // A fresh identity is resolved and shown.
    await waitFor(() => expect(calls("changes_resolve_live_detail")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer-hunk-position").textContent).toBe("Change 1 of 1"),
    );
  });

  test("a stale refusal is reported with a reload, and nothing is retried", async () => {
    liveFile(2);
    handlers.changes_stage_hunk = () => ({
      kind: "error",
      error: { code: "precondition-failed", reasonKey: "changes.staging.index-changed" },
    });
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+new 1");

    fireEvent.click(screen.getByRole("button", { name: "Stage change 1" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Not staged");
    expect(alert.textContent).toContain("The staged version of this file changed");
    expect(calls("changes_stage_hunk")).toHaveLength(1);
    expect(calls("changes_resolve_live_detail")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reload and review again" }));
    await waitFor(() => expect(calls("changes_resolve_live_detail")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
  });

  test("switches to the unstaged and staged views; the staged view unstages", async () => {
    liveFile(1);
    handlers.changes_stage_hunk = () => ({
      kind: "applied",
      action: "unstage",
      pathId: "u:src/app.ts",
    });
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+new 1");
    const compare = screen.getByRole("group", { name: "Compare" });
    expect(compare.textContent).toBe("All changesUnstagedStaged");

    fireEvent.click(screen.getByRole("button", { name: "Unstaged" }));
    await waitFor(() =>
      expect(calls("changes_resolve_live_detail").at(-1)).toEqual({
        resourceKey: UNSTAGED_KEY,
        pathId: "u:src/app.ts",
      }),
    );
    expect(screen.getByRole("button", { name: "Unstaged" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await screen.findByRole("button", { name: "Stage change 1" });

    fireEvent.click(screen.getByRole("button", { name: "Staged" }));
    await screen.findByRole("button", { name: "Unstage change 1" });
    // The staged diff ends at the index, not the working file.
    expect(screen.getByTestId("diff-viewer-endpoints").textContent).toContain(
      "Staged version (index)",
    );
    expect(calls("changes_resolve_live_detail").at(-1)).toEqual({
      resourceKey: STAGED_KEY,
      pathId: "u:src/app.ts",
    });
    fireEvent.click(screen.getByRole("button", { name: "Unstage change 1" }));
    await screen.findByText(/Unstaged change 1\./);
    expect(calls("changes_stage_hunk").at(-1)).toMatchObject({ action: "unstage" });
  });

  test("a file with nothing staged says so in the staged view", async () => {
    liveFile(1);
    const resolveFile = handlers.changes_resolve_live_detail!;
    handlers.changes_resolve_live_detail = (args) =>
      args?.resourceKey === STAGED_KEY
        ? {
            kind: "error",
            error: { code: "not-found", reasonKey: "changes.reason.empty-index-scope" },
          }
        : resolveFile(args);
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+new 1");
    fireEvent.click(screen.getByRole("button", { name: "Staged" }));
    expect(await screen.findByText("No staged changes in this file")).toBeTruthy();
    // The switch stays available to go back.
    fireEvent.click(screen.getByRole("button", { name: "All changes" }));
    await screen.findByText("+new 1");
  });

  test.each(["file-rows-capped", "untracked-scan-capped"])(
    "a capped comparison stays unavailable (%s)",
    async (reason) => {
      liveFile(1);
      const resolveFile = handlers.changes_resolve_live_detail!;
      handlers.changes_resolve_live_detail = (args) =>
        args?.resourceKey === UNSTAGED_KEY
          ? { kind: "error", error: { code: "not-found", reasonKey: `changes.reason.${reason}` } }
          : resolveFile(args);
      renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
      await screen.findByText("+new 1");
      fireEvent.click(screen.getByRole("button", { name: "Unstaged" }));
      await screen.findByText("Diff unavailable");
      expect(screen.queryByText("No unstaged changes in this file") === null).toBe(true);
    },
  );

  test("file buttons are disabled when only hunkless files remain", async () => {
    const comparison = {
      ...identity("diff-h", "turn-net"),
      kind: "comparison",
      beforeSnapshotId: "a",
      afterSnapshotId: "b",
    } as DiffIdentity;
    handlers.changes_get_diff = () =>
      body(comparison, [file("before", []), file("text", [hunk(1, "text")]), file("after", [])]);
    renderInAppCommandScope(
      <DiffViewerTab
        target={{ kind: "historical", diffIdentityId: "diff-h", title: "t" }}
        isActive
      />,
    );
    for (const name of ["Previous file", "Next file"]) {
      expect((await screen.findByRole<HTMLButtonElement>("button", { name })).disabled).toBe(true);
    }
  });

  test("the cut final hunk is disabled while earlier hunks can stage", async () => {
    liveFile(2);
    handlers.changes_get_diff = () =>
      body(identity("diff-environment-net-1", "environment-net"), [
        { ...file("src/app.ts", [hunk(1, "first"), hunk(20, "last")]), truncated: true },
      ]);
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: "Stage change 1" })).disabled,
    ).toBe(false);
    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: "Stage change 2" })).disabled,
    ).toBe(true);
  });

  test("another mounted index viewer re-resolves a changed path", async () => {
    liveFile(1);
    const target = { ...live, resourceKey: UNSTAGED_KEY };
    handlers.changes_stage_hunk = () => {
      handlers.changes_get_diff = (args) =>
        body(identity(String(args?.diffIdentityId), "unstaged"), [
          file("src/app.ts", [hunk(20, "remaining")]),
        ]);
      appCommandStore(changeProjectionStore)
        .getState()
        .applyContentInvalidation(UNSTAGED_KEY, 1, ["u:src/app.ts"], "owner");
      return { kind: "applied", action: "stage", pathId: "u:src/app.ts" };
    };
    renderInAppCommandScope(
      <>
        <section aria-label="First">
          <DiffViewerTab target={target} isActive />
        </section>
        <section aria-label="Second">
          <DiffViewerTab target={target} isActive />
        </section>
      </>,
    );
    const first = within(screen.getByRole("region", { name: "First" }));
    const second = within(screen.getByRole("region", { name: "Second" }));
    await second.findByRole("button", { name: "Stage change 1" });
    const stage = await first.findByRole("button", { name: "Stage change 1" });
    expect(calls("changes_resolve_live_detail")).toHaveLength(2);
    await act(async () => fireEvent.click(stage));
    await second.findByText("+new remaining");
    expect(calls("changes_stage_hunk")).toHaveLength(1);
  });

  test("no staging without the backend capability or in the whitespace view", async () => {
    liveFile(1);
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByRole("button", { name: "Stage change 1" });
    fireEvent.click(screen.getByRole("button", { name: "Hide whitespace changes" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stage change 1" }) === null).toBe(true),
    );
    cleanup();

    resetChangeTrackingCapabilitiesForTests();
    delete handlers.changes_get_capabilities;
    renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+new 1");
    expect(screen.queryByRole("button", { name: "Stage change 1" }) === null).toBe(true);
    expect(screen.queryByRole("group", { name: "Compare" }) === null).toBe(true);
    // Navigation needs no capability.
    expect(screen.getByTestId("diff-viewer-hunk-position").textContent).toBe("Change 1 of 1");
  });
});
