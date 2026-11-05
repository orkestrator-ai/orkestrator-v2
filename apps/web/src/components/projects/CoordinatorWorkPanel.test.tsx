import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CoordinatorWorkItem } from "@/lib/coordinator-work-items";
import { useUIStore } from "@/stores/uiStore";
import {
  CoordinatorNextWakeLine,
  CoordinatorWorkPanel,
  WORK_PANEL_WIDE_QUERY,
} from "./CoordinatorWorkPanel";

const originalMatchMedia = window.matchMedia;
let wideScreen = true;

function mediaQueryList(query: string): MediaQueryList {
  return {
    matches: query === WORK_PANEL_WIDE_QUERY ? wideScreen : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
}

const items: CoordinatorWorkItem[] = [
  {
    key: "worker::asking",
    associationIds: ["a-asking"],
    kind: "worker",
    bucket: "needs-you",
    name: "fix-login",
    stage: "Worker · waiting for you",
    target: { type: "worker-tab", projectId: "p", environmentId: "asking", tabId: "t" },
    openDelegations: 1,
    prOpen: false,
    sortAt: 3,
  },
  {
    key: "build::pipe",
    associationIds: ["a-pipe"],
    kind: "build",
    bucket: "running",
    name: "Work panel",
    machine: "Studio",
    stage: "Build · Verify",
    criteria: { passed: 9, total: 12 },
    target: {
      type: "remote",
      nodeId: "n",
      projectId: "p",
      environmentId: "e",
      title: "Work panel",
    },
    openDelegations: 0,
    prOpen: false,
    sortAt: 2,
  },
  {
    key: "pull-request::env",
    associationIds: ["a-pr-1", "a-pr-2"],
    kind: "pull-request",
    bucket: "finished",
    name: "PR #42",
    stage: "PR merged",
    target: null,
    unavailableReason: "The pull request has not been opened yet.",
    openDelegations: 0,
    prOpen: false,
    finishedAt: 1,
    sortAt: 1,
  },
];
const counts = { running: 1, needsYou: 1, finished: 1 };
const clearFinished = mock(async (_associationIds: string[]) => undefined);

describe("CoordinatorWorkPanel", () => {
  beforeEach(() => {
    wideScreen = true;
    window.matchMedia = mediaQueryList as typeof window.matchMedia;
    clearFinished.mockClear();
    useUIStore.setState({ collapsedWorkBuckets: [] });
  });
  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  test("is open by default on a wide screen, with status as text in each section", () => {
    render(
      <CoordinatorWorkPanel
        items={items}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    const panel = screen.getByRole("complementary", { name: "Work" });
    expect(screen.queryByRole("button", { name: /Show work/ }) === null).toBe(true);
    const sections = within(panel)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual(["Needs you (1)", "Running (1)", "Finished (1)"]);
    expect(within(panel).getByText("Build · Verify")).toBeTruthy();
    expect(within(panel).getByText("9/12 criteria")).toBeTruthy();
    expect(within(panel).getByText("on Studio")).toBeTruthy();
    expect(within(panel).getByText("1 running, 1 needs you")).toBeTruthy();
    expect(panel.getAttribute("data-open-delegations")).toBe("1");
  });

  test("Open buttons go to their work and are disabled, with a reason, when there is none", () => {
    const onOpen = mock(() => undefined);
    render(
      <CoordinatorWorkPanel
        items={items}
        counts={counts}
        openDelegations={1}
        onOpen={onOpen}
        onClearFinished={clearFinished}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open fix-login" }));
    expect(onOpen).toHaveBeenCalledWith(items[0]!.target);
    fireEvent.click(screen.getByRole("button", { name: "Open Work panel" }));
    expect(onOpen).toHaveBeenLastCalledWith(items[1]!.target);
    const unavailable = screen.getByRole("button", {
      name: "Open PR #42: The pull request has not been opened yet.",
    }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("title")).toBe("The pull request has not been opened yet.");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  test("on a narrow screen it is a strip with counts that expands when clicked", async () => {
    wideScreen = false;
    render(
      <CoordinatorWorkPanel
        items={items}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    expect(screen.queryByRole("complementary", { name: "Work" }) === null).toBe(true);
    const strip = screen.getByRole("button", { name: "Show work: 1 running, 1 needs you" });
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(strip.textContent).toContain("running");
    expect(strip.textContent).toContain("needs you");

    fireEvent.click(strip);
    const panel = screen.getByRole("complementary", { name: "Work" });
    expect(within(panel).getByRole("button", { name: "Open fix-login" })).toBeTruthy();
    const hide = screen.getByRole("button", { name: "Hide work panel" });
    await waitFor(() => expect(document.activeElement).toBe(hide));

    // Escape returns a narrow screen to the strip, with focus on it.
    fireEvent.keyDown(panel, { key: "Escape" });
    const again = screen.getByRole("button", { name: /Show work/ });
    await waitFor(() => expect(document.activeElement).toBe(again));
  });

  test("a wide panel can be hidden to the strip and shown again", () => {
    render(
      <CoordinatorWorkPanel
        items={items}
        counts={counts}
        openDelegations={0}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide work panel" }));
    expect(screen.queryByRole("complementary", { name: "Work" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Show work/ }));
    expect(screen.getByRole("complementary", { name: "Work" })).toBeTruthy();
  });

  test("says what will appear when nothing has been started", () => {
    render(
      <CoordinatorWorkPanel
        items={[]}
        counts={{ running: 0, needsYou: 0, finished: 0 }}
        openDelegations={0}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
  });

  test("a section folds and unfolds from its heading, and remembers it", () => {
    const panel = () => (
      <CoordinatorWorkPanel
        items={items}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />
    );
    const { unmount } = render(panel());
    const finished = screen.getByRole("button", { name: "Finished (1)" });
    expect(finished.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^Open PR #42/ })).toBeTruthy();

    fireEvent.click(finished);
    expect(finished.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Open PR #42/ }) === null).toBe(true);
    // The count stays, and the other sections are unaffected.
    expect(screen.getByRole("heading", { level: 3, name: "Finished (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open fix-login" })).toBeTruthy();

    unmount();
    render(panel());
    expect(screen.queryByRole("button", { name: /^Open PR #42/ }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Finished (1)" }));
    expect(screen.getByRole("button", { name: /^Open PR #42/ })).toBeTruthy();
  });

  test("Clear sends every record behind the finished rows and waits for the answer", async () => {
    let settle!: () => void;
    clearFinished.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (settle = () => resolve(undefined))),
    );
    render(
      <CoordinatorWorkPanel
        items={items}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    const clear = screen.getByRole("button", {
      name: "Clear 1 finished item",
    }) as HTMLButtonElement;
    fireEvent.click(clear);
    expect(clearFinished).toHaveBeenCalledWith(["a-pr-1", "a-pr-2"]);
    expect(clear.disabled).toBe(true);
    settle();
    await waitFor(() => expect(clear.disabled).toBe(false));
  });

  test("Clear is offered only for finished work that can go", () => {
    const openPr = { ...items[2]!, key: "open", name: "PR #43", prOpen: true };
    const { unmount } = render(
      <CoordinatorWorkPanel
        items={[items[0]!, items[1]!, openPr]}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Clear/ }) === null).toBe(true);
    unmount();

    render(
      <CoordinatorWorkPanel
        items={[items[2]!, openPr]}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    const clear = screen.getByRole("button", { name: "Clear 1 finished item" });
    expect(clear.getAttribute("title")).toContain("still open stays");
    fireEvent.click(clear);
    expect(clearFinished).toHaveBeenCalledWith(["a-pr-1", "a-pr-2"]);
  });

  test("right-clicking a finished row clears only that row", async () => {
    const other = { ...items[2]!, key: "other", name: "PR #43", associationIds: ["a-other"] };
    render(
      <CoordinatorWorkPanel
        items={[...items, other]}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    fireEvent.contextMenu(screen.getByText("PR #43"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear" }));
    expect(clearFinished).toHaveBeenCalledTimes(1);
    expect(clearFinished).toHaveBeenCalledWith(["a-other"]);
  });

  test("rows that cannot be cleared have no right-click menu", () => {
    const openPr = { ...items[2]!, key: "open", name: "PR #43", prOpen: true };
    render(
      <CoordinatorWorkPanel
        items={[items[0]!, items[1]!, openPr]}
        counts={counts}
        openDelegations={1}
        onOpen={() => {}}
        onClearFinished={clearFinished}
      />,
    );
    for (const name of ["fix-login", "Work panel", "PR #43"]) {
      fireEvent.contextMenu(screen.getByText(name));
      expect(screen.queryByRole("menuitem", { name: "Clear" }) === null).toBe(true);
    }
  });

  test("a row shows what was asked, on what and since when; a record without them still renders", () => {
    render(
      <CoordinatorWorkPanel
        items={[
          {
            ...items[0]!,
            summary: "Fix the login redirect",
            agent: "claude",
            model: "opus",
            overridden: true,
            age: "12m",
          },
          { ...items[1]!, age: undefined },
        ]}
        counts={counts}
        openDelegations={1}
        onOpen={() => undefined}
        onClearFinished={clearFinished}
      />,
    );
    const [asked, plain] = screen.getAllByRole("listitem");
    expect(asked!.querySelector("[data-work-summary]")?.textContent).toBe("Fix the login redirect");
    expect(asked!.querySelector("[data-work-meta]")?.textContent).toBe(
      "Claude Code · opus · requested · 12m",
    );
    expect(plain!.querySelector("[data-work-summary]") === null).toBe(true);
    expect(plain!.querySelector("[data-work-meta]") === null).toBe(true);
    expect(within(plain!).getByRole("button", { name: "Open Work panel" })).toBeTruthy();
  });

  test("Stop stops that row's worker and comes back when the stop settles", async () => {
    let settle = () => {};
    const stop = { environmentId: "asking", tabIds: ["t"] };
    const onStop = mock(() => new Promise<void>((resolve) => (settle = resolve)));
    render(
      <CoordinatorWorkPanel
        items={[{ ...items[0]!, stop }, items[1]!]}
        counts={counts}
        openDelegations={1}
        onOpen={() => undefined}
        onStop={onStop}
        onClearFinished={clearFinished}
      />,
    );
    // Only a row with something to stop offers it.
    expect(screen.queryByRole("button", { name: "Stop Work panel" }) === null).toBe(true);
    const button = screen.getByRole("button", { name: "Stop fix-login" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledWith(stop);
    expect(button.disabled).toBe(true);
    settle();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  test("offers no Stop while nothing can be stopped from here", () => {
    render(
      <CoordinatorWorkPanel
        items={[{ ...items[0]!, stop: { environmentId: "asking", tabIds: ["t"] } }]}
        counts={counts}
        openDelegations={1}
        onOpen={() => undefined}
        onClearFinished={clearFinished}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop fix-login" }) === null).toBe(true);
  });

  test("the next wake line shows on a narrow screen only, while the coordinator is idle", () => {
    const waiting = [{ ...items[0]!, name: "api-fix", openDelegations: 1 }];
    wideScreen = false;
    const narrow = render(<CoordinatorNextWakeLine items={waiting} quiet={false} />);
    expect(screen.getByRole("status").textContent).toBe("Next wake when api-fix finishes");
    narrow.unmount();

    const busy = render(<CoordinatorNextWakeLine items={waiting} quiet={true} />);
    expect(screen.queryByRole("status") === null).toBe(true);
    busy.unmount();

    const none = render(<CoordinatorNextWakeLine items={[items[1]!]} quiet={false} />);
    expect(screen.queryByRole("status") === null).toBe(true);
    none.unmount();

    wideScreen = true;
    render(<CoordinatorNextWakeLine items={waiting} quiet={false} />);
    expect(screen.queryByRole("status") === null).toBe(true);
  });
});
