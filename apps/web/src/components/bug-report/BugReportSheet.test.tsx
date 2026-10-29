import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BugReportSnapshot, BugReportSummary } from "@orkestrator/protocol/bug-report";
import * as backend from "@/lib/backend";
import * as realNativeAgent from "@/components/native-agent";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { createSessionKey } from "@/lib/utils";
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

  for (const failure of ["get", "create"] as const) {
    test(`Retry reloads after an initial ${failure} failure`, async () => {
      const get = spyOn(backend, "getBugReport").mockResolvedValue(snapshot(null));
      const create = spyOn(backend, "createBugReport").mockResolvedValue(snapshot({}));
      if (failure === "get")
        get.mockResolvedValueOnce(snapshot(null)).mockRejectedValueOnce(new Error("load failed"));
      else create.mockRejectedValueOnce(new Error("load failed"));
      await openSheet();
      expect(await screen.findByText("load failed")).toBeTruthy();
      const before = get.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByTestId("native-agent");
      expect(get.mock.calls.length).toBe(before + 1);
      expect(useBugReportStore.getState().sheetOpen).toBe(true);
    });
  }

  for (const clipboard of ["missing", "rejected"] as const) {
    test(`retains a complete long body with ${clipboard} clipboard access`, async () => {
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          clipboard === "missing"
            ? undefined
            : {
                writeText: mock(async () => {
                  throw new Error("denied");
                }),
              },
      });
      try {
        const next = snapshot({ agent: "codex" }, true);
        next.draft!.body = "long body ".repeat(1000);
        spyOn(backend, "getBugReport").mockResolvedValue(next);
        spyOn(backend, "fileBugReport").mockResolvedValue({
          kind: "browser",
          url: "https://github.com/orkestrator-ai/orkestrator-v2/issues/new",
          bodyInUrl: false,
          reason: "Opened on GitHub",
        });
        const opened = spyOn(backend, "openInBrowser").mockResolvedValue(undefined);
        await openSheet();
        fireEvent.click(await screen.findByRole("button", { name: "File issue" }));
        const fallback = await screen.findByRole("textbox", { name: "Issue body for manual copy" });
        expect((fallback as HTMLTextAreaElement).value).toBe(next.draft!.body);
        expect(screen.getByText(/Clipboard access failed/)).toBeTruthy();
        await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    });
  }

  for (const mutation of ["discard", "assign"] as const) {
    test(`ignores a poll that completes after ${mutation}`, async () => {
      let tick!: () => void;
      const interval = globalThis.setInterval;
      spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
        if (ms === 3000) {
          tick = callback;
          return 123456;
        }
        return interval(callback, ms);
      }) as typeof setInterval);
      spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
      const get = spyOn(backend, "getBugReport").mockResolvedValue(snapshot({}));
      spyOn(backend, "discardBugReport").mockResolvedValue(snapshot(null));
      spyOn(backend, "assignBugReportAgent").mockResolvedValue(snapshot({ agent: "claude" }));
      await openSheet();
      await screen.findByTestId("native-agent");
      let release!: (value: BugReportSnapshot) => void;
      get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      act(() => tick());
      if (mutation === "discard") {
        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        fireEvent.click(screen.getByRole("button", { name: "Discard report?" }));
        await waitFor(() => expect(useBugReportStore.getState().sheetOpen).toBe(false));
      } else {
        await act(async () => {
          await (tabProps.at(-1)!.onAssignPlatform as (...args: unknown[]) => Promise<void>)(
            "claude",
            "test",
            { fastMode: false },
          );
        });
      }
      await act(async () => release(snapshot({})));
      if (mutation === "discard") expect(useBugReportStore.getState().draftInProgress).toBe(false);
      else expect((tabProps.at(-1)!.data as { platform: string }).platform).toBe("claude");
    });
  }

  test("captures the window and attaches the saved screenshot to the report composer", async () => {
    const capture = mock(async () => "png-base64");
    window.orkestrator = {
      bugReport: { captureWindow: capture },
    } as unknown as typeof window.orkestrator;
    spyOn(backend, "getBugReport").mockResolvedValue(snapshot({ agent: "codex" }));
    const savedPath = `${REPORT.scratchDir}/screenshots/window.png`;
    const save = spyOn(backend, "saveBugReportScreenshot").mockResolvedValue({
      path: savedPath,
      snapshot: snapshot({ agent: "codex", screenshots: [savedPath] }),
    });
    const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    try {
      await openSheet();
      fireEvent.click(await screen.findByRole("button", { name: "Capture window" }));
      await waitFor(() => expect(save).toHaveBeenCalledWith("r1", "png-base64"));
      const key = createSessionKey(REPORT.runtimeId, REPORT.tabId);
      await waitFor(() =>
        expect(useNativeComposeStore.getState().drafts.get(key)?.attachments).toMatchObject([
          { path: savedPath, type: "image" },
        ]),
      );
      expect(useBugReportStore.getState().sheetOpen).toBe(true);
    } finally {
      raf.mockRestore();
    }
  });

  test("uncertain filing keeps the approved body and allows an existing issue URL to resolve it", async () => {
    spyOn(backend, "getBugReport").mockResolvedValue(snapshot({ agent: "codex" }, true));
    spyOn(backend, "fileBugReport").mockRejectedValue(
      new Error("A filing attempt may already have created this issue. Check GitHub"),
    );
    const mark = spyOn(backend, "markBugReportFiled").mockResolvedValue(
      snapshot({ filed: { url: "https://github.com/a/b/issues/1", filedAt: "t" } }),
    );
    const opened = spyOn(backend, "openInBrowser").mockResolvedValue(undefined);
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: "File issue" }));
    expect(await screen.findByLabelText("Issue body for manual copy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check existing issues" }));
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith(
        "https://github.com/orkestrator-ai/orkestrator-v2/issues",
      ),
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
