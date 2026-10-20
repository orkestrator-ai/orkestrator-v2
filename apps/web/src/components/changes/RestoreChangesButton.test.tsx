import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";
import { invoke } from "@/lib/native/backend";
import { resetChangeTrackingCapabilitiesForTests } from "@/lib/backend/changes";
import { RestoreChangesButton } from "./RestoreChangesButton";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function projection(restoreEnabled: boolean): ChangeProjection {
  return {
    schemaVersion: 1,
    resourceKey: "turn-net/turn/t1/live",
    ownerGeneration: "g",
    revision: 1,
    measurementId: "m1",
    state: "ready",
    availability: "ready",
    observationState: "fresh",
    coverageState: "complete",
    labelKey: "changes.scope.turn-net",
    labelArgs: {},
    hasFileChanges: true,
    hasTextChanges: true,
    badge: { visible: true, mode: "counts" },
    counters: {
      additions: { value: 1, quality: "complete", bound: "exact" },
      deletions: { value: 1, quality: "complete", bound: "exact" },
      changedFiles: 1,
    },
    provenanceLabelKey: "changes.provenance.observed-fresh",
    reasonKeys: [],
    freshness: {
      lastAttemptAt: null,
      lastSuccessfulCheckAt: null,
      lastContentChangeObservedAt: null,
      observedAt: null,
      requiredObservationEpoch: null,
      checkedObservationEpoch: null,
    },
    detail: null,
    filePage: null,
    actions: [
      {
        kind: "restore",
        targetToken: "m1",
        enabled: restoreEnabled,
        reasonKey: restoreEnabled ? null : "changes.restore.no-retained-endpoints",
      },
    ],
  };
}

const calls: Array<{ command: string; args: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  resetChangeTrackingCapabilitiesForTests();
  invokeMock.mockImplementation(async (command: string, args: unknown) => {
    calls.push({ command, args });
    if (command === "changes_get_capabilities")
      return { capability: "change-tracking-v1", restore: true };
    if (command === "changes_prepare_restore") {
      return {
        kind: "preview",
        actionToken: "tok",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        files: [
          { pathId: "u:a.txt", pathDisplay: "a.txt", action: "write", reasonKey: null },
          {
            pathId: "u:b.txt",
            pathDisplay: "b.txt",
            action: "skip",
            reasonKey: "changes.restore.destination-changed",
          },
        ],
        residualRiskKeys: ["changes.restore.risk.external-writers"],
      };
    }
    if (command === "changes_apply_restore") {
      return {
        kind: "applied",
        operationId: "op",
        outcome: "complete",
        completedPathIds: ["u:a.txt"],
        failedPathIds: [],
        resultMeasurementId: null,
      };
    }
    return null;
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("RestoreChangesButton", () => {
  test("previews the backend preflight and applies only after confirmation", async () => {
    render(<RestoreChangesButton projection={projection(true)} />);
    const button = await screen.findByTestId("restore-changes-button");
    fireEvent.click(button);
    const dialog = await screen.findByTestId("restore-preview");
    expect(dialog.textContent).toContain("b.txt");
    expect(dialog.textContent).toContain("skip");
    expect(calls.some((call) => call.command === "changes_apply_restore")).toBe(false);
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Restored 1 file"),
    );
    const apply = calls.find((call) => call.command === "changes_apply_restore")!;
    expect((apply.args as { actionToken: string }).actionToken).toBe("tok");
  });

  test("a backend-disabled restore stays disabled with its reason", async () => {
    render(<RestoreChangesButton projection={projection(false)} />);
    const button = await screen.findByTestId("restore-changes-button");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
  test("an uncertain apply retries the same prepared token and idempotency key", async () => {
    render(<RestoreChangesButton projection={projection(true)} />);
    fireEvent.click(await screen.findByTestId("restore-changes-button"));
    await screen.findByTestId("restore-preview");
    let attempts = 0;
    invokeMock.mockImplementation(async (command: string, args: unknown) => {
      calls.push({ command, args });
      if (command === "changes_apply_restore" && ++attempts === 1) throw new Error("response lost");
      return {
        kind: "applied",
        operationId: "op",
        outcome: "complete",
        completedPathIds: ["u:a.txt"],
        failedPathIds: [],
        resultMeasurementId: null,
      };
    });
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("result is unknown"),
    );
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Restored 1 file"),
    );
    const applies = calls.filter((call) => call.command === "changes_apply_restore");
    expect(applies).toHaveLength(2);
    expect(applies[0]?.args).toEqual(applies[1]?.args);
  });
});
