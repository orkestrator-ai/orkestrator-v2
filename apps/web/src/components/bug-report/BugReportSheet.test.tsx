import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BugReportSnapshot, BugReportSummary } from "@orkestrator/protocol/bug-report";
import * as backend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import { useBugReportStore } from "@/stores/bugReportStore";

const nativeAgentSnapshot = { ...realNativeAgent };
const tabProps: Record<string, unknown>[] = [];
mock.module("@/components/native-agent", () => ({
  ...nativeAgentSnapshot,
  AgentNativeTab: (props: Record<string, unknown>) => {
    tabProps.push(props);
    return <div data-testid="native-agent" />;
  },
}));

const { BugReportSheet } = await import("./BugReportSheet");

const REPORT: BugReportSummary = {
  id: "r1",
  runtimeId: "bug-report:r1",
  tabId: "bug-report-r1",
  createdAt: "2026-10-29T00:00:00.000Z",
  scratchDir: "/tmp/orkestrator-bug-report-x",
  screenshots: [],
};

function snapshot(report: Partial<BugReportSummary> | null, draft = false): BugReportSnapshot {
  return {
    report: report ? { ...REPORT, ...report } : null,
    draft: draft
      ? { title: "Sidebar crashes", body: "## Summary\nIt crashes.", updatedAt: "t" }
      : null,
  };
}

const originalOrkestrator = window.orkestrator;

beforeEach(() => {
  window.orkestrator = undefined;
  tabProps.length = 0;
});

afterEach(() => {
  cleanup();
  mock.restore();
  useBugReportStore.setState({ sheetOpen: false, draftInProgress: false });
  window.orkestrator = originalOrkestrator;
});

afterAll(() => {
  mock.module("@/components/native-agent", () => nativeAgentSnapshot);
});

async function openSheet() {
  render(<BugReportSheet />);
  await act(async () => {
    useBugReportStore.getState().openSheet();
  });
}

describe("BugReportSheet", () => {
  test("starts a report on first open and hosts its unassigned session", async () => {
    spyOn(backend, "getBugReport").mockResolvedValue(snapshot(null));
    const create = spyOn(backend, "createBugReport").mockResolvedValue(snapshot({}));
    const assign = spyOn(backend, "assignBugReportAgent").mockResolvedValue(
      snapshot({ agent: "claude" }),
    );
    await openSheet();
    await screen.findByTestId("native-agent");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ surface: "web", rendererErrors: [] });
    const props = tabProps.at(-1)!;
    expect(props.tabId).toBe("bug-report-r1");
    expect(props.data).toMatchObject({ environmentId: "bug-report:r1", isLocal: true });
    expect(props.coordinatorWorkspacePath).toBe(REPORT.scratchDir);
    expect(props.availablePlatforms).toEqual(["claude", "codex", "opencode"]);

    // The first message chooses the agent; the tab then sends it.
    await act(async () => {
      await (props.onAssignPlatform as (...args: unknown[]) => Promise<void>)(
        "claude",
        "It crashed",
        { fastMode: false },
      );
    });
    expect(assign).toHaveBeenCalledWith("r1", "claude");
    await waitFor(() => expect(tabProps.at(-1)!.initialPrompt).toBe("It crashed"));
    expect(tabProps.at(-1)!.onAssignPlatform).toBeUndefined();
    expect(useBugReportStore.getState().draftInProgress).toBe(true);
  });

  test("files the approved draft with gh", async () => {
    const get = spyOn(backend, "getBugReport").mockResolvedValue(
      snapshot({ agent: "codex" }, true),
    );
    const file = spyOn(backend, "fileBugReport").mockResolvedValue({
      kind: "filed",
      url: "https://github.com/orkestrator-ai/orkestrator-v2/issues/7",
    });
    await openSheet();
    expect(await screen.findByText("Sidebar crashes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getByText(/It crashes\./)).toBeTruthy();
    get.mockResolvedValue(
      snapshot({
        agent: "codex",
        filed: { url: "https://github.com/orkestrator-ai/orkestrator-v2/issues/7", filedAt: "t" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "File issue" }));
    await waitFor(() =>
      expect(file).toHaveBeenCalledWith("r1", {
        title: "Sidebar crashes",
        body: "## Summary\nIt crashes.",
      }),
    );
    expect(await screen.findByText("Issue filed. Thank you!")).toBeTruthy();
    expect(useBugReportStore.getState().draftInProgress).toBe(false);
  });

  test("hands over to GitHub when gh cannot file, then records the issue", async () => {
    spyOn(backend, "getBugReport").mockResolvedValue(snapshot({ agent: "claude" }, true));
    spyOn(backend, "fileBugReport").mockResolvedValue({
      kind: "browser",
      url: "https://github.com/orkestrator-ai/orkestrator-v2/issues/new?title=x",
      bodyInUrl: true,
      reason: "GitHub CLI is not signed in on this host",
    });
    const opened = spyOn(backend, "openInBrowser").mockResolvedValue(undefined);
    const mark = spyOn(backend, "markBugReportFiled").mockResolvedValue(
      snapshot({
        agent: "claude",
        filed: { url: "https://github.com/a/b/issues/1", filedAt: "t" },
      }),
    );
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "File issue" }));
    expect(await screen.findByText("Finish on GitHub")).toBeTruthy();
    expect(opened).toHaveBeenCalledWith(
      "https://github.com/orkestrator-ai/orkestrator-v2/issues/new?title=x",
    );
    fireEvent.change(screen.getByLabelText("GitHub issue URL"), {
      target: { value: "https://github.com/a/b/issues/1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith("r1", "https://github.com/a/b/issues/1"));
  });

  test("discards only after confirmation", async () => {
    spyOn(backend, "getBugReport").mockResolvedValue(snapshot({ agent: "claude" }));
    const discard = spyOn(backend, "discardBugReport").mockResolvedValue(snapshot(null));
    await openSheet();
    await screen.findByTestId("native-agent");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard report?" }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(useBugReportStore.getState().sheetOpen).toBe(false));
  });
});
