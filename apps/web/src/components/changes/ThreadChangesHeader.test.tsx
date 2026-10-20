import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChangeHistoryEntry, ChangeProjection } from "@orkestrator/protocol/change-resources";
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import { invoke } from "@/lib/native/backend";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import { ThreadChangesHeader } from "./ThreadChangesHeader";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const ENV = "env-1";
const SESSION = "env-env-1:tab-1";
const THREAD_KEY = "thread-net/segment/seg-1/live";

function count(value: number): LineCount {
  return { value, quality: "complete", bound: "exact" };
}

function projection(
  resourceKey: string,
  overrides: Partial<ChangeProjection> = {},
): ChangeProjection {
  return {
    schemaVersion: 1,
    resourceKey,
    ownerGeneration: "gen-1",
    revision: 1,
    measurementId: `m-${resourceKey}`,
    state: "ready",
    availability: "ready",
    observationState: "fresh",
    coverageState: "complete",
    labelKey: "changes.scope.thread-net",
    labelArgs: {},
    hasFileChanges: true,
    hasTextChanges: true,
    badge: { visible: true, mode: "counts" },
    counters: { additions: count(12), deletions: count(3), changedFiles: 2 },
    provenanceLabelKey: "changes.provenance.observed",
    reasonKeys: [],
    freshness: {
      lastAttemptAt: null,
      lastSuccessfulCheckAt: null,
      lastContentChangeObservedAt: null,
      observedAt: null,
      requiredObservationEpoch: null,
      checkedObservationEpoch: null,
    },
    detail: { diffIdentityId: `diff-${resourceKey}` },
    filePage: null,
    actions: [],
    ...overrides,
  };
}

function historyEntry(turnId: string, providerKey?: string): ChangeHistoryEntry {
  const turnKey = `turn-net/turn/${turnId}/final`;
  return {
    turnId,
    segmentId: "seg-1",
    lifecycle: "finished",
    startedAt: "2026-10-20T10:00:00.000Z",
    finishedAt: "2026-10-20T10:05:00.000Z",
    turnResourceKey: turnKey,
    measurementId: `m-${turnKey}`,
    presentation: {
      schemaVersion: 1,
      turnId,
      revision: 1,
      changes: [
        { role: "turn-net", resourceKey: turnKey, prominence: "primary" },
        ...(providerKey
          ? [
              {
                role: "provider-turn-diff" as const,
                resourceKey: providerKey,
                prominence: "secondary" as const,
              },
            ]
          : []),
      ],
    },
  };
}

interface Backend {
  thread: { segmentId: string; resourceKey: string } | null;
  projections: Map<string, ChangeProjection>;
  pages: Map<string | null, { entries: ChangeHistoryEntry[]; nextCursor: string | null }>;
}

function installBackend(backend: Backend) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "changes_get_thread":
        return backend.thread;
      case "changes_get_view": {
        const found = backend.projections.get(args.resourceKey as string);
        return found
          ? { kind: "projection", projection: found }
          : { kind: "deleted", resourceKey: args.resourceKey };
      }
      case "changes_get_history": {
        const page = backend.pages.get((args.cursor as string | null | undefined) ?? null);
        return page ? { kind: "page", ...page } : { kind: "page", entries: [], nextCursor: null };
      }
      default:
        return undefined;
    }
  });
}

function resetStore() {
  useChangeProjectionStore.setState({
    projections: new Map(),
    deleted: new Set(),
    contentGenerations: new Map(),
    toolPresentations: new Map(),
  });
}

describe("ThreadChangesHeader", () => {
  beforeEach(() => {
    resetChangeSubscriptionsForTests();
    resetStore();
  });
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("renders the thread badge from the backend projection and opens a historical diff", async () => {
    installBackend({
      thread: { segmentId: "seg-1", resourceKey: THREAD_KEY },
      projections: new Map([[THREAD_KEY, projection(THREAD_KEY)]]),
      pages: new Map(),
    });
    const onOpenDiff = mock(() => {});
    render(
      <ThreadChangesHeader
        environmentId={ENV}
        logicalSessionKey={SESSION}
        turnActive={false}
        onOpenDiff={onOpenDiff}
      />,
    );
    const badge = await screen.findByTestId("thread-changes-badge");
    expect(badge.textContent).toBe("+12-3");
    const summary = screen.getByTestId("thread-changes-summary");
    expect(summary.getAttribute("title")).toContain("Thread changes");
    expect(within(summary).getByTestId("change-state-tag").textContent).toContain("Final");
    expect(invokeMock).toHaveBeenCalledWith("changes_get_thread", {
      environmentId: ENV,
      logicalSessionKey: SESSION,
    });

    fireEvent.click(summary);
    expect(onOpenDiff).toHaveBeenCalledWith("Thread changes", {
      kind: "historical",
      diffIdentityId: `diff-${THREAD_KEY}`,
      title: "Thread changes",
    });
  });

  test("shows a provisional thread measurement as live", async () => {
    installBackend({
      thread: { segmentId: "seg-1", resourceKey: THREAD_KEY },
      projections: new Map([
        [THREAD_KEY, projection(THREAD_KEY, { reasonKeys: ["changes.reason.provisional"] })],
      ]),
      pages: new Map(),
    });
    render(<ThreadChangesHeader environmentId={ENV} logicalSessionKey={SESSION} turnActive />);
    const tag = await screen.findByTestId("change-state-tag");
    expect(tag.textContent).toContain("Live");
    expect(tag.getAttribute("data-change-state")).toBe("live");
    expect(screen.getByTestId("thread-changes-summary").getAttribute("title")).toContain(
      "Still in progress",
    );
  });

  test("renders nothing when the thread has no segment yet", async () => {
    installBackend({ thread: null, projections: new Map(), pages: new Map() });
    const { container } = render(
      <ThreadChangesHeader environmentId={ENV} logicalSessionKey={SESSION} turnActive={false} />,
    );
    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([command]) => command === "changes_get_thread")).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.innerHTML).toBe("");
    expect(invokeMock.mock.calls.some(([command]) => command === "changes_get_view")).toBe(false);
  });

  test("re-reads the thread segment when a turn ends", async () => {
    const backend: Backend = { thread: null, projections: new Map(), pages: new Map() };
    installBackend(backend);
    const { rerender } = render(
      <ThreadChangesHeader environmentId={ENV} logicalSessionKey={SESSION} turnActive />,
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "changes_get_thread"),
      ).toHaveLength(1),
    );
    expect(screen.queryByTestId("thread-changes-header") === null).toBe(true);

    backend.thread = { segmentId: "seg-1", resourceKey: THREAD_KEY };
    backend.projections.set(THREAD_KEY, projection(THREAD_KEY));
    rerender(
      <ThreadChangesHeader environmentId={ENV} logicalSessionKey={SESSION} turnActive={false} />,
    );
    expect(await screen.findByTestId("thread-changes-badge")).toBeTruthy();
  });

  test("lists turn-net and provider-turn-diff separately, pages, and opens a turn diff", async () => {
    const turnOneKey = "turn-net/turn/t1/final";
    const providerKey = "provider-turn-diff/turn/pt1/final";
    const turnTwoKey = "turn-net/turn/t2/live";
    installBackend({
      thread: { segmentId: "seg-1", resourceKey: THREAD_KEY },
      projections: new Map([
        [THREAD_KEY, projection(THREAD_KEY)],
        [
          turnOneKey,
          projection(turnOneKey, {
            labelKey: "changes.scope.turn-net",
            counters: { additions: count(5), deletions: count(1), changedFiles: 1 },
          }),
        ],
        [
          providerKey,
          projection(providerKey, {
            labelKey: "changes.scope.provider-turn-diff",
            counters: { additions: count(7), deletions: count(2), changedFiles: 1 },
            detail: null,
          }),
        ],
        [
          turnTwoKey,
          projection(turnTwoKey, {
            labelKey: "changes.scope.turn-net",
            reasonKeys: ["changes.reason.provisional"],
            counters: { additions: count(1), deletions: count(0), changedFiles: 1 },
          }),
        ],
      ]),
      pages: new Map([
        [null, { entries: [historyEntry("t1", providerKey)], nextCursor: "1" }],
        [
          "1",
          {
            entries: [
              {
                ...historyEntry("t2"),
                lifecycle: "running",
                turnResourceKey: turnTwoKey,
                presentation: {
                  schemaVersion: 1,
                  turnId: "t2",
                  revision: 1,
                  changes: [{ role: "turn-net", resourceKey: turnTwoKey, prominence: "primary" }],
                },
              },
            ],
            nextCursor: null,
          },
        ],
      ]),
    });
    const onOpenDiff = mock(() => {});
    render(
      <ThreadChangesHeader
        environmentId={ENV}
        logicalSessionKey={SESSION}
        turnActive={false}
        onOpenDiff={onOpenDiff}
      />,
    );
    fireEvent.click(await screen.findByTestId("turn-changes-toggle"));

    const [first] = await screen.findAllByTestId("turn-changes-entry");
    const turnLine = await within(first!).findByTestId("turn-net-line-badge");
    expect(turnLine.textContent).toBe("+5-1");
    const providerBadge = await within(first!).findByTestId("provider-turn-diff-line-badge");
    expect(providerBadge.textContent).toBe("+7-2");
    expect(within(first!).getByTestId("turn-net-line").textContent).toContain(
      "This turn's changes",
    );
    expect(within(first!).getByTestId("provider-turn-diff-line").textContent).toContain(
      "Provider-reported turn changes",
    );
    // Separate lines, never a combined total.
    expect(first!.textContent).not.toContain("+12");
    // The provider line has no detail identity, so only the turn-net line opens.
    expect(
      within(within(first!).getByTestId("provider-turn-diff-line")).queryByRole("button") === null,
    ).toBe(true);

    fireEvent.click(within(within(first!).getByTestId("turn-net-line")).getByRole("button"));
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    const [title, target] = onOpenDiff.mock.calls[0] as unknown as [string, unknown];
    expect(title).toContain("This turn's changes");
    expect(target).toEqual({ kind: "historical", diffIdentityId: `diff-${turnOneKey}`, title });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByTestId("turn-changes-entry")).toHaveLength(2));
    const second = screen.getAllByTestId("turn-changes-entry")[1]!;
    const tag = await within(second).findByTestId("change-state-tag");
    expect(tag.textContent).toContain("Live");
    expect(tag.textContent).toContain("Still in progress");
    expect(within(second).queryByTestId("provider-turn-diff-line") === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" }) === null).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("changes_get_history", {
      environmentId: ENV,
      logicalSessionKey: SESSION,
      cursor: "1",
      pageSize: 25,
    });
  });
});
