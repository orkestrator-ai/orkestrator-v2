import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RecoveryCopyList } from "@orkestrator/protocol/container-recovery";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import type { Environment } from "@/types";
import { EnvironmentRecoveryCopies } from "./EnvironmentRecoveryCopies";
import {
  mockToastSuccess,
  mockToastWarning,
  resetSonnerMocks,
} from "../../../../../tests/mocks/sonner";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handlers[command]?.(args),
  );
}

const environment = {
  id: "env-copies",
  environmentType: "containerized",
  containerId: "current",
} as unknown as Environment;

const list: RecoveryCopyList = {
  environmentId: "env-copies",
  revision: 12,
  limit: 16,
  copies: [
    {
      copyId: "legacy",
      kind: "legacy-runtime",
      reason: "migrate-source",
      retainedAt: "2026-09-01T00:00:00.000Z",
      operationId: null,
      containerId: "legacy",
      storageSetId: null,
      volumes: [],
      workspaceGeneration: null,
      presence: "present",
      sizeBytes: 1024,
      restorable: true,
    },
    {
      copyId: "failed",
      kind: "storage-set",
      reason: "failed-candidate",
      retainedAt: null,
      operationId: null,
      containerId: null,
      storageSetId: "failed",
      volumes: ["v"],
      workspaceGeneration: 1,
      presence: "partial",
      sizeBytes: null,
      restorable: false,
    },
  ],
};

describe("environment recovery copies", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("restores a copy bound to the reviewed container and revision", async () => {
    const restore = mock((_args: Record<string, unknown>) => undefined);
    install({
      list_recovery_copies: () => list,
      restore_recovery_copy: restore,
      sync_environment_status: () => environment,
    });
    render(
      <EnvironmentRecoveryCopies
        environment={environment}
        dockerAvailable
        onUpdate={() => undefined}
        onClose={() => undefined}
      />,
    );
    await screen.findByText("Container before moving to persistent storage");
    expect(screen.getByText(/Some of its Docker resources no longer exist/)).toBeTruthy();
    const restoreButtons = screen.getAllByRole("button", { name: "Restore…" });
    expect((restoreButtons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(restoreButtons[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(restore.mock.calls[0]?.[0]).toEqual({
      environmentId: "env-copies",
      copyId: "legacy",
      expectedContainerId: "current",
      expectedRevision: 12,
    });
  });

  test("deleting a copy asks first and sends the reviewed revision", async () => {
    const discard = mock((_args: Record<string, unknown>) => ({
      copyId: "failed",
      discarded: true,
      kept: { containerId: null, volumes: [] },
    }));
    install({ list_recovery_copies: () => list, discard_recovery_copy: discard });
    render(
      <EnvironmentRecoveryCopies
        environment={environment}
        dockerAvailable
        onUpdate={() => undefined}
        onClose={() => undefined}
      />,
    );
    await screen.findByText("Incomplete rebuild (cannot be restored)");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete…" })[1]!);
    expect(discard).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete copy" }));
    await waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    expect(discard.mock.calls[0]?.[0]).toEqual({
      environmentId: "env-copies",
      copyId: "failed",
      expectedRevision: 12,
    });
  });

  test("a restore is reported from the backend's record, not from the call returning", async () => {
    const snapshot = (status: string) => ({
      revision: 13,
      supported: true,
      runtimeGeneration: 3,
      imageId: null,
      storageFormat: "volume-v1",
      workspaceGeneration: 1,
      operation: null,
      lastOutcome: { operationId: "op", kind: "restore", status, finishedAt: "x" },
      bootPhase: null,
    });
    for (const [status, expected] of [
      ["succeeded", mockToastSuccess],
      ["failed", mockToastWarning],
    ] as const) {
      resetSonnerMocks();
      install({
        list_recovery_copies: () => list,
        restore_recovery_copy: () => undefined,
        sync_environment_status: () => environment,
        get_container_lifecycle_snapshot: () => snapshot(status),
      });
      render(
        <EnvironmentRecoveryCopies
          environment={environment}
          dockerAvailable
          onUpdate={() => undefined}
          onClose={() => undefined}
        />,
      );
      await screen.findByText("Container before moving to persistent storage");
      fireEvent.click(screen.getAllByRole("button", { name: "Restore…" })[0]!);
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
      await waitFor(() => expect(expected).toHaveBeenCalledTimes(1));
      cleanup();
    }
  });
});
