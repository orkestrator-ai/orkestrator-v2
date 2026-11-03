import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CoordinatorWorkItem } from "@/lib/coordinator-work-items";
import { CoordinatorWorkPanel, WORK_PANEL_WIDE_QUERY } from "./CoordinatorWorkPanel";

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

describe("CoordinatorWorkPanel", () => {
  beforeEach(() => {
    wideScreen = true;
    window.matchMedia = mediaQueryList as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  test("is open by default on a wide screen, with status as text in each section", () => {
    render(
      <CoordinatorWorkPanel items={items} counts={counts} openDelegations={1} onOpen={() => {}} />,
    );
    const panel = screen.getByRole("complementary", { name: "Work" });
    expect(screen.queryByRole("button", { name: /Show work/ })).toBeNull();
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
      <CoordinatorWorkPanel items={items} counts={counts} openDelegations={1} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open fix-login" }));
    expect(onOpen).toHaveBeenCalledWith(items[0]!.target);
    fireEvent.click(screen.getByRole("button", { name: "Open Work panel" }));
    expect(onOpen).toHaveBeenLastCalledWith(items[1]!.target);
    const unavailable = screen.getByRole("button", { name: "Open PR #42" }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("title")).toBe("The pull request has not been opened yet.");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  test("on a narrow screen it is a strip with counts that expands when clicked", async () => {
    wideScreen = false;
    render(
      <CoordinatorWorkPanel items={items} counts={counts} openDelegations={1} onOpen={() => {}} />,
    );
    expect(screen.queryByRole("complementary", { name: "Work" })).toBeNull();
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
      <CoordinatorWorkPanel items={items} counts={counts} openDelegations={0} onOpen={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide work panel" }));
    expect(screen.queryByRole("complementary", { name: "Work" })).toBeNull();
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
      />,
    );
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
  });
});
