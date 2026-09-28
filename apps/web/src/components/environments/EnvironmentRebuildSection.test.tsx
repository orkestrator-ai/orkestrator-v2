import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type {
  ContainerLifecycleSnapshot,
  RebuildPreview,
} from "@orkestrator/protocol/container-lifecycle";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import type { Environment } from "@/types";
import { EnvironmentRebuildSection } from "./EnvironmentRebuildSection";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handlers[command]?.(args),
  );
}

const environment = {
  id: "env-rebuild",
  name: "Rebuild",
  environmentType: "containerized",
  containerId: "reviewed-container",
  status: "running",
} as unknown as Environment;

function snapshot(operation: ContainerLifecycleSnapshot["operation"] = null) {
  return {
    revision: 3,
    supported: true,
    runtimeGeneration: 1,
    imageId: null,
    storageFormat: "legacy-layer",
    workspaceGeneration: 1,
    operation,
    lastOutcome: null,
    bootPhase: null,
  } satisfies ContainerLifecycleSnapshot;
}

function preview(overrides: Partial<RebuildPreview> = {}): RebuildPreview {
  return {
    environmentId: environment.id,
    containerId: "reviewed-container",
    available: true,
    kind: "migrate",
    preservedPaths: ["/workspace — tracked, untracked and ignored files"],
    notPreserved: ["Running processes"],
    providers: [
      { provider: "claude", level: "full", limitations: null, resumeQualified: false },
      {
        provider: "opencode",
        level: "partial",
        limitations: "Revert snapshots are not kept.",
        resumeQualified: false,
      },
    ],
    retainedCopies: 0,
    retainedCopyLimit: 16,
    ...overrides,
  };
}

describe("environment rebuild section", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("describes what is kept and binds the rebuild to the reviewed container", async () => {
    install({
      get_container_lifecycle_snapshot: () => snapshot(),
      get_rebuild_preview: () => preview(),
      sync_environment_status: () => environment,
    });
    const onRestart = mock(async () => undefined);
    const beforeRebuild = mock(async () => undefined);
    render(
      <EnvironmentRebuildSection
        environment={environment}
        dockerAvailable
        onRestart={onRestart}
        beforeRebuild={beforeRebuild}
        onUpdate={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rebuild \(keeps files\)/ }));
    await screen.findByText("Rebuild container and keep its files?");
    expect(screen.getByText(/partly: Revert snapshots are not kept/)).toBeTruthy();
    expect(screen.getByText("Running processes")).toBeTruthy();
    expect(
      screen.getByText(/Continuing a conversation\s+after a rebuild has been verified for/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1));
    expect(beforeRebuild).toHaveBeenCalledTimes(1);
    expect(onRestart.mock.calls[0]).toEqual([
      environment.id,
      { intent: "preserve", expectedContainerId: "reviewed-container" },
    ] as never);
  });

  test("explains why a rebuild is unavailable and offers no action", async () => {
    install({
      get_container_lifecycle_snapshot: () => snapshot(),
      get_rebuild_preview: () =>
        preview({ available: false, unavailableReason: "image-without-storage-contract" }),
    });
    const onRestart = mock(async () => undefined);
    render(
      <EnvironmentRebuildSection
        environment={environment}
        dockerAvailable
        onRestart={onRestart}
        beforeRebuild={async () => undefined}
        onUpdate={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rebuild \(keeps files\)/ }));
    await screen.findByText("Rebuild unavailable");
    expect(screen.getByText(/predates persistent storage/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rebuild" }) === null).toBe(true);
    expect(onRestart).not.toHaveBeenCalled();
  });

  test("rehydrates an in-flight rebuild from the backend and can cancel it", async () => {
    const cancel = mock((_args: Record<string, unknown>) => ({ cancelled: true, pending: true }));
    install({
      get_container_lifecycle_snapshot: () =>
        snapshot({
          operationId: "op-1",
          kind: "migrate",
          status: "running",
          phase: "copying",
          startedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          failureCode: null,
        }),
      cancel_container_operation: cancel,
    });
    render(
      <EnvironmentRebuildSection
        environment={environment}
        dockerAvailable
        onRestart={async () => undefined}
        beforeRebuild={async () => undefined}
        onUpdate={() => undefined}
        onClose={() => undefined}
      />,
    );
    await screen.findByText(/Copying and verifying files/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel rebuild" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel.mock.calls[0]?.[0]).toEqual({
      environmentId: environment.id,
      operationId: "op-1",
    });
  });

  test("reports a rejected cancellation", async () => {
    const report = spyOn(toast, "error").mockImplementation(() => "toast-id");
    try {
      install({
        get_container_lifecycle_snapshot: () =>
          snapshot({
            operationId: "op-2",
            kind: "migrate",
            status: "running",
            phase: "copying",
            startedAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            failureCode: null,
          }),
        cancel_container_operation: () => Promise.reject(new Error("Connection lost")),
      });
      render(
        <EnvironmentRebuildSection
          environment={environment}
          dockerAvailable
          onRestart={async () => undefined}
          beforeRebuild={async () => undefined}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />,
      );
      await screen.findByText(/Copying and verifying files/);
      fireEvent.click(screen.getByRole("button", { name: "Cancel rebuild" }));
      await waitFor(() =>
        expect(report).toHaveBeenCalledWith("Could not cancel the rebuild", {
          description: "Connection lost",
        }),
      );
    } finally {
      report.mockRestore();
    }
  });
});
