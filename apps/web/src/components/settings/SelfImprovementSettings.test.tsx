import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  SelfImprovementRunStart,
  SelfImprovementRunSummary,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { AppConfig } from "@/types";
import { AccountMachineProvider } from "./account-machine";
import {
  SelfImprovementSettings,
  type SelfImprovementSettingsProps,
} from "./SelfImprovementSettings";

afterEach(cleanup);

const RUN: SelfImprovementRunSummary = {
  digestId: "20261109T090000Z-abc",
  trigger: "manual",
  startedAt: "2026-11-09T09:00:00.000Z",
  finishedAt: "2026-11-09T09:04:00.000Z",
  outcome: "succeeded",
  created: [
    {
      ticket: "418",
      signature: "insight:use-mise-not-npm",
      title: "Agents keep reaching for npm",
    },
  ],
  linked: [],
  verified: [{ ticket: "412", signature: "local-server:bridge.exited:codex:SIGKILL" }],
  fixFailed: [{ ticket: "414", signature: "storage:snapshot.failed:ENOSPC", verdict: "unchanged" }],
  partly: [],
  markedFixed: [],
  reopenedFromBoard: [],
  ignoredDeleted: [],
  wouldCreate: [],
  heldForTomorrow: 0,
  belowBar: 4,
  conversations: {
    enabled: true,
    read: 12,
    waiting: 0,
    notesAdded: 9,
    themes: 3,
    costUsd: 0.41,
    heldForTomorrow: 1,
    errors: [],
  },
};

function status(overrides: Partial<SelfImprovementStatus> = {}): SelfImprovementStatus {
  return {
    enabled: true,
    settings: { projectId: "p1", conversationReview: true, dailyRun: false },
    project: { id: "p1", name: "orkestrator-v2" },
    running: null,
    lastRun: RUN,
    nextDailyRunAt: null,
    tracked: [
      {
        signature: "insight:use-mise-not-npm",
        title: "Agents keep reaching for npm",
        kind: "insight",
        status: "tracking",
        ticket: "418",
        verdict: "tracking",
        baseline: 0.25,
        unit: "of conversations",
        updatedAt: "2026-11-09T09:04:00.000Z",
      },
      {
        signature: "local-server:bridge.exited:codex:SIGKILL",
        title: "local-server bridge.exited (codex): SIGKILL",
        kind: "diagnostics",
        status: "verified",
        ticket: "412",
        verdict: "improved",
        baseline: 5.1,
        unit: "per day",
        updatedAt: "2026-11-09T09:04:00.000Z",
      },
    ],
    themes: [
      {
        slug: "use-mise-not-npm",
        title: "Agents keep reaching for npm",
        kind: "repeated-instruction",
        fixWhere: "instructions",
        summary: "You keep telling agents to use mise for tests and installs.",
        conversations: 3,
        severity: 2,
        updatedAt: "2026-11-09T09:04:00.000Z",
      },
    ],
    models: { notes: "claude-sonnet-5-5", themes: "claude-opus-5-5" },
    limits: { diagnosticsTicketsPerDay: 3, insightTicketsPerDay: 2, conversationPartsPerRun: 30 },
    ...overrides,
  };
}

function fakeApi(initial: SelfImprovementStatus) {
  let current = initial;
  const api = {
    getSelfImprovementStatus: mock(async () => current),
    runSelfImprovement: mock(
      async (_options?: { dryRun?: boolean }): Promise<SelfImprovementRunStart> => ({
        started: true,
        status: (current = {
          ...current,
          running: { trigger: "manual", startedAt: RUN.startedAt, step: "reading-conversations" },
        }),
      }),
    ),
    getProjects: mock(async () => [
      { id: "p1", name: "orkestrator-v2" },
      { id: "p2", name: "my-app" },
    ]),
    patchGlobalConfig: mock(
      async (patch: { selfImprovement?: SelfImprovementStatus["settings"] }) => {
        current = { ...current, settings: { ...current.settings, ...patch.selfImprovement } };
        return { global: { selfImprovement: patch.selfImprovement } } as unknown as AppConfig;
      },
    ),
    set(next: SelfImprovementStatus) {
      current = next;
    },
  };
  return api;
}

function render(api: ReturnType<typeof fakeApi>, machine?: string | null) {
  const props = { api: api as unknown as SelfImprovementSettingsProps["api"] };
  return renderInAppCommandScope(
    machine === undefined ? (
      <SelfImprovementSettings {...props} />
    ) : (
      <AccountMachineProvider value={{ machine, name: null }}>
        <SelfImprovementSettings {...props} />
      </AccountMachineProvider>
    ),
  );
}

describe("Settings → Self-improvement", () => {
  test("shows the last run, tracked tickets and themes", async () => {
    render(fakeApi(status()));
    expect((await screen.findAllByText("Agents keep reaching for npm")).length).toBeGreaterThan(0);
    expect(screen.getByText("Fixed and confirmed")).toBeTruthy();
    // Tracked problems appear by title, not by signature.
    expect(screen.getAllByText("local-server bridge.exited (codex): SIGKILL").length).toBe(2);
    expect(screen.getByText("Fix did not work, moved back to the backlog")).toBeTruthy();
    expect(screen.getByText(/read 12 parts, 9 new notes, 3 themes/)).toBeTruthy();
    expect(screen.getByText(/about \$0\.41 at list prices/)).toBeTruthy();
    expect(screen.getByText("Confirmed fixed")).toBeTruthy();
    expect(screen.getByText("Fix in instructions")).toBeTruthy();
    expect(
      screen.getByText(/Sonnet 5\.5 reads each conversation, Opus 5\.5 groups the notes/),
    ).toBeTruthy();
  });

  test("Run now starts a run and follows it", async () => {
    const api = fakeApi(status());
    render(api);
    const button = await screen.findByRole("button", { name: /Run now/ });
    fireEvent.click(button);
    await waitFor(() => expect(api.runSelfImprovement).toHaveBeenCalledWith({ dryRun: false }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Reading conversations");
    expect((screen.getByRole("button", { name: /Run now/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("Preview asks for a dry run, and a refusal is explained", async () => {
    const api = fakeApi(
      status({
        settings: { projectId: null, conversationReview: true, dailyRun: false },
        project: null,
        lastRun: null,
      }),
    );
    api.runSelfImprovement.mockImplementationOnce(async () => ({
      started: false,
      refusal: "no-project" as const,
      status: await api.getSelfImprovementStatus(),
    }));
    render(api);
    expect(await screen.findByText(/No runs yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await waitFor(() => expect(api.runSelfImprovement).toHaveBeenCalledWith({ dryRun: true }));
    expect(
      await screen.findByText("Choose the project that should receive tickets first."),
    ).toBeTruthy();
  });

  test("switches save the whole settings object through a config patch", async () => {
    const api = fakeApi(status());
    render(api);
    const daily = await screen.findByRole("switch", { name: "Run daily" });
    fireEvent.click(daily);
    await waitFor(() =>
      expect(api.patchGlobalConfig).toHaveBeenCalledWith({
        selfImprovement: { projectId: "p1", conversationReview: true, dailyRun: true },
      }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Review conversations" }));
    await waitFor(() =>
      expect(api.patchGlobalConfig).toHaveBeenLastCalledWith({
        selfImprovement: { projectId: "p1", conversationReview: false, dailyRun: true },
      }),
    );
  });

  test("on another machine it says where it runs and calls nothing", async () => {
    const api = fakeApi(status());
    render(api, "leaf-2");
    expect(await screen.findByText(/runs on the machine this window runs on/)).toBeTruthy();
    expect(api.getSelfImprovementStatus).not.toHaveBeenCalled();
  });
});
