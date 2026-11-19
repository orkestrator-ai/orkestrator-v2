import { afterAll, afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandStore } from "@/test/app-command-store";
import { exactCount, type ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type ChangeDiffFileBody,
  type ChangeDiffLine,
  type ChangesGetDiffResult,
  type DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import { invoke } from "@/lib/native/backend";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { changeProjectionStore } from "@/stores/changeProjectionStore";
import { diffCommentsStore, environmentDiffComments } from "@/stores/diffCommentsStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { ChangeDiffTarget, TabInfo } from "@/types/paneLayout";
import { DiffViewerTab } from "@/components/terminal/DiffViewerTab";
import {
  mockToastError,
  mockToastSuccess,
  resetSonnerMocks,
} from "../../../../../tests/mocks/sonner";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";

type InvokeArgs = Record<string, unknown> | undefined;
type CommandHandler = (args: InvokeArgs) => unknown;

const invokeMock = invoke as unknown as Mock<
  (command: string, args?: InvokeArgs) => Promise<unknown>
>;
let handlers: Record<string, CommandHandler> = {};

const ENV = "env-1";
const originalMatchMedia = window.matchMedia;

function measurement(): ChangeMeasurement {
  return {
    schemaVersion: 1,
    measurementId: "m-1",
    worktreeId: "wt-1",
    worktreeIncarnation: "inc-1",
    scope: "environment-net",
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
    totals: { additions: exactCount(3), deletions: exactCount(1), changedFiles: 1 },
    diffIdentityId: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    supersedesMeasurementId: null,
  };
}

function fileIdentity(id: string, afterBlob: string): DiffIdentity {
  return {
    id,
    worktreeId: "wt-1",
    worktreeIncarnation: "inc-1",
    scope: "environment-net",
    measurementId: `m-${id}`,
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "raw-bytes-v1",
    rendererPolicyId: "hunks-v1",
    whitespacePolicy: "preserve",
    kind: "file",
    before: { state: "present", snapshotId: "snap-a", pathId: "p:src/app.ts", blobId: "blob-a" },
    after: { state: "present", snapshotId: "snap-b", pathId: "p:src/app.ts", blobId: afterBlob },
    basePathDisplay: "src/app.ts",
    targetPathDisplay: "src/app.ts",
  };
}

const LINES: ChangeDiffLine[] = [
  { type: "context", text: "import { read } from './io';", oldLine: 1, newLine: 1 },
  { type: "remove", text: "const value = read() ?? 0;", oldLine: 2, newLine: null },
  { type: "add", text: "const value = read();", oldLine: null, newLine: 2 },
  { type: "add", text: "console.log(value);", oldLine: null, newLine: 3 },
  { type: "add", text: "export { value };", oldLine: null, newLine: 4 },
];

function body(identity: DiffIdentity, lines: ChangeDiffLine[] = LINES): ChangesGetDiffResult {
  const file: ChangeDiffFileBody = {
    pathId: "p:src/app.ts",
    oldPathDisplay: "src/app.ts",
    newPathDisplay: "src/app.ts",
    status: "modified",
    fileKind: "text",
    bodyAvailability: "available",
    reasonKey: null,
    hunks: [
      { header: "@@ -1,2 +1,4 @@", oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines },
    ],
    truncated: false,
  };
  return {
    kind: "body",
    identity,
    measurement: measurement(),
    files: [file],
    nextCursor: null,
    viewIdentityId: identity.id,
  };
}

const live: ChangeDiffTarget = {
  kind: "live",
  resourceKey: environmentChangeResourceKey(ENV),
  path: "src/app.ts",
  title: "app.ts",
};

function agentTab(id: string): TabInfo {
  return {
    id,
    type: "agent-native",
    nativeAgentData: { environmentId: ENV, platform: "claude" },
  } as TabInfo;
}

function seedAgentTabs(tabs: TabInfo[]) {
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        ENV,
        {
          root: { kind: "leaf", id: "default", tabs, activeTabId: tabs[0]?.id ?? null },
          activePaneId: "default",
          containerId: null,
        },
      ],
    ]),
    activeEnvironmentId: ENV,
  } as never);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function comments() {
  return environmentDiffComments(appCommandStore(diffCommentsStore).getState(), ENV).comments;
}

async function addComment(buttonName: string, text: string) {
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  const editor = await screen.findByTestId("diff-comment-editor");
  fireEvent.change(within(editor).getByRole("textbox"), { target: { value: text } });
  fireEvent.click(within(editor).getByRole("button", { name: "Add comment" }));
  await waitFor(() => expect(screen.queryByTestId("diff-comment-editor")).toBeNull());
}

let identity = fileIdentity("diff-1", "blob-b");

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  resetChangeSubscriptionsForTests();
  resetSonnerMocks();
  mockWriteText.mockClear();
  appCommandStore(changeProjectionStore).setState({
    projections: new Map(),
    retiredOwners: new Map(),
    transportRevision: 0,
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
  appCommandStore(diffCommentsStore).setState({ environments: new Map() });
  seedAgentTabs([agentTab("tab-1")]);
  identity = fileIdentity("diff-1", "blob-b");
  handlers = {
    changes_get_view: () => ({
      kind: "error",
      error: { code: "unsupported-capability", reasonKey: "changes.error.unsupported" },
    }),
    changes_resolve_live_detail: () => ({ kind: "identity", identity }),
    changes_get_diff: () => body(identity),
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

describe("diff review comments", () => {
  test("reviews five issues, sends one batch and keeps what changed during the send", async () => {
    renderInAppCommandScope(<DiffViewerTab target={live} environmentId={ENV} isActive />);
    await screen.findByText("+const value = read();");

    await addComment("Comment on src/app.ts removed line 2", "Keep the fallback to 0.");
    await addComment("Comment on src/app.ts line 2", "read() can return undefined.");
    await addComment("Comment on src/app.ts line 3", "Remove the debug log.");
    await addComment("Comment on src/app.ts line 4", "Export a function instead.");
    await addComment("Comment on src/app.ts hunk @@ -1,2 +1,4 @@", "Add a test for this.");

    // Shown inline under their lines, and counted in the tray.
    expect(screen.getAllByTestId("diff-comment")).toHaveLength(5);
    expect(screen.getByTestId("diff-comment-count").textContent).toBe("5 comments");

    const write = deferred<unknown>();
    const enqueued: InvokeArgs[] = [];
    handlers.enqueue_prompt_queue_message = (args) => {
      enqueued.push(args);
      return write.promise;
    };
    fireEvent.click(screen.getByRole("button", { name: "Send 5 to Claude Code" }));
    await waitFor(() => expect(enqueued).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeTruthy();

    // One prompt, on the agent tab's queue, quoting every comment and its code.
    const message = enqueued[0]?.message as { text: string; id: string };
    expect(enqueued[0]?.queueKey).toBe(`claude\u0000env-${ENV}:tab-1`);
    expect(message.text).toContain("(5 comments)");
    expect(message.text).toContain("## 1. src/app.ts:2 (removed line)");
    expect(message.text).toContain("-const value = read() ?? 0;");
    expect(message.text).toContain("## 5. src/app.ts, hunk @@ -1,2 +1,4 @@");
    expect(message.text).toContain("Remove the debug log.");

    // While the send is in flight: edit one comment and add another.
    const target = screen
      .getAllByTestId("diff-comment")
      .find((card) => card.textContent?.includes("Remove the debug log."))!;
    fireEvent.click(within(target).getByRole("button", { name: "Edit comment on src/app.ts:3" }));
    const editor = await screen.findByTestId("diff-comment-editor");
    fireEvent.change(within(editor).getByRole("textbox"), {
      target: { value: "Log through the logger instead." },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Edited while sending")).toBeTruthy();
    await addComment("Comment on src/app.ts line 1", "Use the shared io module.");

    await act(async () => write.resolve({ messages: [] }));

    await waitFor(() => expect(comments()).toHaveLength(2));
    expect(comments().map((comment) => comment.body)).toEqual([
      "Log through the logger instead.",
      "Use the shared io module.",
    ]);
    expect(screen.getAllByTestId("diff-comment")).toHaveLength(2);
    expect(screen.getByTestId("diff-comment-count").textContent).toBe("2 comments");
    expect(mockToastSuccess.mock.calls[0]?.[0]).toBe("Sent 5 comments to Claude Code");
  });

  test("shows a comment as outdated once the file moves on, and says so in the request", async () => {
    renderInAppCommandScope(<DiffViewerTab target={live} environmentId={ENV} isActive />);
    await screen.findByText("+console.log(value);");
    await addComment("Comment on src/app.ts line 3", "Remove the debug log.");

    // The agent rewrote the file: the live view resolves a new identity.
    identity = fileIdentity("diff-2", "blob-c");
    handlers.changes_get_diff = () =>
      body(identity, [
        { type: "context", text: "import { read } from './io';", oldLine: 1, newLine: 1 },
        { type: "add", text: "export const value = read();", oldLine: null, newLine: 2 },
      ]);
    fireEvent.click(screen.getByRole("button", { name: "Reload diff" }));
    await screen.findByText("+export const value = read();");

    const elsewhere = await screen.findByTestId("diff-comments-elsewhere");
    expect(within(elsewhere).getByText("Outdated")).toBeTruthy();
    expect(within(elsewhere).getByText("src/app.ts:3")).toBeTruthy();

    const enqueued: InvokeArgs[] = [];
    handlers.enqueue_prompt_queue_message = (args) => {
      enqueued.push(args);
      return { messages: [] };
    };
    fireEvent.click(screen.getByRole("button", { name: "Send 1 to Claude Code" }));
    await waitFor(() => expect(enqueued).toHaveLength(1));
    const text = (enqueued[0]!.message as { text: string }).text;
    expect(text).toContain("this file has changed since the comment was written");
    expect(text).toContain("+console.log(value);");
  });

  test("keeps every comment when the send fails", async () => {
    renderInAppCommandScope(<DiffViewerTab target={live} environmentId={ENV} isActive />);
    await screen.findByText("+console.log(value);");
    await addComment("Comment on src/app.ts line 3", "Remove the debug log.");
    handlers.enqueue_prompt_queue_message = () => {
      throw new Error("Environment is stopped");
    };

    fireEvent.click(screen.getByRole("button", { name: "Send 1 to Claude Code" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Not sent: Environment is stopped");
    expect(comments()).toHaveLength(1);
    expect(mockToastError).toHaveBeenCalled();
  });

  test("lets the user pick which comments and which agent chat, or copy the request", async () => {
    seedAgentTabs([agentTab("tab-1"), agentTab("tab-2")]);
    renderInAppCommandScope(<DiffViewerTab target={live} environmentId={ENV} isActive />);
    await screen.findByText("+console.log(value);");
    await addComment("Comment on src/app.ts line 3", "Remove the debug log.");
    await addComment("Comment on src/app.ts line 4", "Export a function instead.");

    fireEvent.click(screen.getByRole("button", { name: /2 comments/ }));
    fireEvent.click(
      screen.getAllByRole("checkbox", { name: "Include comment src/app.ts in the request" })[1]!,
    );
    expect(screen.getByTestId("diff-comment-count").textContent).toBe("2 comments · 1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Copy comments as a request" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));
    const copied = (mockWriteText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain("Remove the debug log.");
    expect(copied).not.toContain("Export a function instead.");

    fireEvent.change(screen.getByRole("combobox", { name: "Agent to send comments to" }), {
      target: { value: "tab-2" },
    });
    const enqueued: InvokeArgs[] = [];
    handlers.enqueue_prompt_queue_message = (args) => {
      enqueued.push(args);
      return { messages: [] };
    };
    fireEvent.click(screen.getByRole("button", { name: "Send 1" }));
    await waitFor(() => expect(comments()).toHaveLength(1));
    expect(enqueued[0]?.queueKey).toBe(`claude\u0000env-${ENV}:tab-2`);
    expect(comments()[0]?.body).toBe("Export a function instead.");
  });

  test("offers no comments without an environment, and no send without an agent chat", async () => {
    const { unmount } = renderInAppCommandScope(<DiffViewerTab target={live} isActive />);
    await screen.findByText("+console.log(value);");
    expect(screen.queryByRole("button", { name: "Comment on src/app.ts line 3" })).toBeNull();
    unmount();

    seedAgentTabs([]);
    renderInAppCommandScope(<DiffViewerTab target={live} environmentId={ENV} isActive />);
    await screen.findByText("+console.log(value);");
    await addComment("Comment on src/app.ts line 3", "Remove the debug log.");
    const send = screen.getByRole("button", { name: "No agent chat" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});
