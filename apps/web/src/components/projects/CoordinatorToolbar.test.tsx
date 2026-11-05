import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readFailuresFreshnessNotice, type FreshnessNotice } from "@/lib/view-freshness";
import { CoordinatorToolbar } from "./CoordinatorToolbar";

const snapshot = {
  projectPath: "/checkout",
  workspace: { repositoryContextRevision: 1 },
  providerAvailability: {},
  controlMcp: { enabled: true, running: true, error: null },
} as unknown as CoordinatorSnapshot;

function renderToolbar(freshness: FreshnessNotice | null) {
  return render(
    <TooltipProvider>
      <CoordinatorToolbar
        snapshot={snapshot}
        git={null}
        gitBusy={false}
        fetching={false}
        conversationBusy={false}
        freshness={freshness}
        runGit={async () => undefined}
        prepareSwitch={async () => undefined}
        activeTurn={null}
        selectedAgent={undefined}
        paused={false}
        onPause={() => undefined}
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("CoordinatorToolbar freshness", () => {
  test("shows nothing while reads are healthy", () => {
    renderToolbar(null);
    expect(screen.queryByText(/out of date/i) === null).toBe(true);
    expect(screen.queryByRole("status") === null).toBe(true);
  });

  test("shows view-freshness wording, with the detail on hover, while reads fail", () => {
    const notice = readFailuresFreshnessNotice(2, "the coordinator")!;
    renderToolbar(notice);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("May be out of date");
    expect(status.getAttribute("title")).toBe(notice.detail);
    expect(status.getAttribute("title")).toContain("the last state received");
  });
});

describe("readFailuresFreshnessNotice", () => {
  test("leaves one failure to the retry, then steps from stale to degraded", () => {
    expect(readFailuresFreshnessNotice(0, "x")).toBeNull();
    expect(readFailuresFreshnessNotice(1, "x")).toBeNull();
    expect(readFailuresFreshnessNotice(2, "x")?.kind).toBe("stale");
    expect(readFailuresFreshnessNotice(4, "x")?.kind).toBe("degraded");
  });
});
