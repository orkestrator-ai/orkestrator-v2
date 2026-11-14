import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  SelfImprovementProgress,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { AppConfig } from "@/types";
import {
  SelfImprovementSettings,
  type SelfImprovementSettingsProps,
} from "./SelfImprovementSettings";
import { RunProgressDialog, RunStages, useNow } from "./SelfImprovementProgress";

afterEach(cleanup);

const OBSERVED = Date.parse("2026-11-14T10:10:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MODELS = { notes: "claude-sonnet-5-5", themes: "claude-opus-5-5" } as const;

const RUNNING = {
  trigger: "manual",
  startedAt: iso(OBSERVED - 95_000),
  step: "reading-conversations",
} as const;

function progress(): SelfImprovementProgress {
  return {
    observedAt: iso(OBSERVED),
    lastActivityAt: iso(OBSERVED - 2000),
    stages: [
      {
        step: "exporting",
        state: "done",
        startedAt: iso(OBSERVED - 95_000),
        finishedAt: iso(OBSERVED - 90_000),
      },
      {
        step: "board",
        state: "done",
        startedAt: iso(OBSERVED - 90_000),
        finishedAt: iso(OBSERVED - 89_000),
      },
      { step: "reading-conversations", state: "running", startedAt: iso(OBSERVED - 89_000) },
      { step: "grouping-themes", state: "pending" },
      { step: "digesting", state: "pending" },
      { step: "filing", state: "pending" },
    ],
    conversations: {
      filesChecked: 120,
      files: 120,
      parts: 30,
      read: 4,
      failed: 0,
      notesAdded: 7,
      waiting: 2,
    },
    modelCalls: { inFlight: 3, oldestStartedAt: iso(OBSERVED - 20_000), timeoutMs: 600_000 },
  };
}

const view = (overrides: Partial<SelfImprovementProgress> = {}) => ({
  running: { ...RUNNING },
  progress: { ...progress(), ...overrides },
  models: MODELS,
  reviewOn: true,
  modelName: (id: string) => (id === "claude-sonnet-5-5" ? "Sonnet 5.5" : "Opus 5.5"),
  clock: { now: 1000, receivedAt: 1000 },
});

describe("RunStages", () => {
  test("lists every stage with where it stands and the live figures", () => {
    render(<RunStages {...view()} onOpen={() => {}} />);
    const list = screen.getByRole("list", { name: "Run stages" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(rows[0]!.textContent).toContain("Exporting this machine's diagnostics");
    expect(rows[0]!.textContent).toContain("5 s");
    expect(rows[2]!.textContent).toContain("Read 4 of 30 parts");
    expect(rows[2]!.querySelector('[aria-current="step"]')).toBeTruthy();
    // Each state has its own text for a screen reader, since the tick boxes are drawn.
    expect(rows.map((row) => row.querySelector(".sr-only")?.textContent)).toEqual([
      "Done",
      "Done",
      "In progress",
      "Waiting",
      "Waiting",
      "Waiting",
    ]);
    expect(screen.getByText(/Waiting on 3 model calls/)).toBeTruthy();
  });

  test("a click on any stage asks to open that stage", () => {
    const onOpen = mock((_step: string) => {});
    render(<RunStages {...view()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Grouping notes into themes/ }));
    expect(onOpen).toHaveBeenCalledWith("grouping-themes");
  });

  test("says so when the run has gone quiet with no model call to wait on", () => {
    render(
      <RunStages
        {...view({
          lastActivityAt: iso(OBSERVED - 5 * 60_000),
          modelCalls: { inFlight: 0, oldestStartedAt: null, timeoutMs: 600_000 },
        })}
        onOpen={() => {}}
      />,
    );
    expect(
      screen.getByText(/Nothing has happened for 5 min 00 s\. It may be stuck\./),
    ).toBeTruthy();
  });
});

describe("RunProgressDialog", () => {
  test("opens above the fullscreen settings layer, with the clicked stage outlined", () => {
    render(
      <RunProgressDialog {...view()} open onOpenChange={() => {}} focus="reading-conversations" />,
    );
    const dialog = screen.getByRole("dialog", { name: /Run in progress/ });
    // The shadcn default (z-50) would sit behind fullscreen settings.
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");

    const details = within(screen.getByRole("list", { name: "Stage details" }));
    const items = details.getAllByRole("listitem");
    expect(items.filter((item) => item.getAttribute("aria-current") === "true")).toHaveLength(1);
    expect(items[2]!.getAttribute("aria-current")).toBe("true");
    expect(items[2]!.textContent).toContain("120 history files checked of 120");
    expect(items[2]!.textContent).toContain("7 notes found so far in 4 parts");
    expect(items[2]!.textContent).toContain("2 more parts waiting for the next run");
    expect(dialog.textContent).toContain("Closing this window does not stop the run.");
  });

  test("closing asks the page to close it", () => {
    const onOpenChange = mock((_open: boolean) => {});
    render(<RunProgressDialog {...view()} open onOpenChange={onOpenChange} focus="board" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("useNow", () => {
  function Clock({ active }: { active: boolean }) {
    const now = useNow(active, 10);
    return <span data-testid="now">{now}</span>;
  }

  test("ticks while active and stops when not", async () => {
    const { rerender } = render(<Clock active />);
    const first = Number(screen.getByTestId("now").textContent);
    await waitFor(() =>
      expect(Number(screen.getByTestId("now").textContent)).toBeGreaterThan(first),
    );
    rerender(<Clock active={false} />);
    const frozen = screen.getByTestId("now").textContent;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByTestId("now").textContent).toBe(frozen);
  });
});

describe("Settings → Self-improvement while a run is in progress", () => {
  function runningStatus(withProgress: boolean): SelfImprovementStatus {
    return {
      enabled: true,
      settings: { projectId: "p1", conversationReview: true, dailyRun: false },
      project: { id: "p1", name: "orkestrator-v2" },
      running: { ...RUNNING, ...(withProgress ? { progress: progress() } : {}) },
      lastRun: null,
      nextDailyRunAt: null,
      tracked: [],
      themes: [],
      models: MODELS,
      limits: { diagnosticsTicketsPerDay: 3, insightTicketsPerDay: 2, conversationPartsPerRun: 30 },
    };
  }

  function page(status: SelfImprovementStatus) {
    const api = {
      getSelfImprovementStatus: mock(async () => status),
      runSelfImprovement: mock(async () => ({ started: false, status })),
      getProjects: mock(async () => [{ id: "p1", name: "orkestrator-v2" }]),
      patchGlobalConfig: mock(async () => ({}) as unknown as AppConfig),
    };
    return renderInAppCommandScope(
      <SelfImprovementSettings api={api as unknown as SelfImprovementSettingsProps["api"]} />,
    );
  }

  test("shows the stages, and a click opens the progress window for that stage", async () => {
    page(runningStatus(true));
    fireEvent.click(await screen.findByRole("button", { name: /Reading conversations/ }));
    const dialog = await screen.findByRole("dialog", { name: /Run in progress/ });
    expect(dialog.className).toContain("z-[80]");
    const current = within(dialog)
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("aria-current") === "true");
    expect(current?.textContent).toContain("Reading conversations");

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    // The run is untouched: the stages are still there.
    expect(screen.getByRole("list", { name: "Run stages" })).toBeTruthy();
  });

  test("a backend that sends no progress still shows the status line, without a stage list", async () => {
    page(runningStatus(false));
    expect((await screen.findByRole("status")).textContent).toContain("Reading conversations");
    expect(screen.queryByRole("list", { name: "Run stages" }) === null).toBe(true);
  });
});
