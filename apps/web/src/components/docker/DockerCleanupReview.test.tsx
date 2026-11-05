import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { RebuildPreview } from "@orkestrator/protocol/container-lifecycle";
import type { CleanupPreview } from "@orkestrator/protocol/container-recovery";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { DockerCleanupReview } from "./DockerCleanupReview";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handlers[command]?.(args),
  );
}

const preview: CleanupPreview = {
  selectionToken: "token-1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  truncated: false,
  rows: [
    {
      kind: "container",
      id: "c-orphan",
      name: "orphan",
      environmentId: null,
      role: "exited",
      sizeBytes: 2048,
      classification: "eligible",
    },
    {
      kind: "volume",
      id: "v-leftover",
      name: "v-leftover",
      environmentId: "gone",
      role: "workspace",
      sizeBytes: null,
      classification: "eligible",
    },
    {
      kind: "volume",
      id: "v-copy",
      name: "v-copy",
      environmentId: "env-1",
      role: "workspace",
      sizeBytes: null,
      classification: "retained-recovery",
    },
  ],
};

const rebuildPreview: RebuildPreview = {
  environmentId: "env-old",
  containerId: "old-container",
  available: true,
  kind: "migrate",
  preservedPaths: ["/workspace — tracked, untracked and ignored files"],
  notPreserved: ["Running processes"],
  providers: [],
  retainedCopies: 0,
  retainedCopyLimit: 16,
};

const withLegacy: CleanupPreview = {
  ...preview,
  legacyRuntimes: [
    {
      environmentId: "env-old",
      environmentName: "Old environment",
      containerId: "old-container",
      exposures: ["host-mounts", "shared-bridge"],
      busy: false,
    },
    {
      environmentId: "env-other",
      environmentName: "Other environment",
      containerId: "other-container",
      exposures: ["host-mounts"],
      busy: true,
    },
  ],
  legacyRuntimesUnchecked: 0,
};

function succeeded() {
  return { operation: null, lastOutcome: { kind: "migrate", status: "succeeded" } };
}

describe("docker cleanup review", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("lists kept resources with reasons and removes only the selected ones", async () => {
    const execute = mock((_args: Record<string, unknown>) => ({
      outcomes: [{ kind: "volume", id: "v-leftover", outcome: "removed" }],
      removed: 1,
      alreadyAbsent: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      reclaimedBytes: 0,
    }));
    install({ docker_cleanup_preview: () => preview, docker_cleanup_execute: execute });
    const onFinished = mock(() => undefined);
    render(<DockerCleanupReview open onOpenChange={() => undefined} onFinished={onFinished} />);
    await screen.findByText("Can be removed (2)");
    expect(screen.getByText(/Recovery copy of an environment/)).toBeTruthy();
    // Deselect the container; only the volume is sent.
    fireEvent.click(screen.getByRole("checkbox", { name: /Container orphan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 selected" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]?.[0]).toEqual({
      selectionToken: "token-1",
      containerIds: [],
      volumeNames: ["v-leftover"],
      networkNames: [],
    });
    await screen.findByText("1 removed");
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  test("reports partial results honestly", async () => {
    install({
      docker_cleanup_preview: () => preview,
      docker_cleanup_execute: () => ({
        outcomes: [],
        removed: 1,
        alreadyAbsent: 0,
        skipped: 0,
        conflicts: 1,
        failed: 0,
        reclaimedBytes: 2048,
      }),
    });
    render(
      <DockerCleanupReview open onOpenChange={() => undefined} onFinished={() => undefined} />,
    );
    await screen.findByText("Can be removed (2)");
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 selected" }));
    await screen.findByText(/1 removed, 1 kept because they became in use/);
  });

  describe("older containers", () => {
    test("lists nothing when no environment has an older container", async () => {
      install({ docker_cleanup_preview: () => ({ ...preview, legacyRuntimes: [] }) });
      render(
        <DockerCleanupReview open onOpenChange={() => undefined} onFinished={() => undefined} />,
      );
      await screen.findByText("Can be removed (2)");
      expect(screen.queryByText(/Older containers/)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Rebuild / })).toBeNull();
    });

    test("a backend that predates the list shows no section and no claim", async () => {
      install({ docker_cleanup_preview: () => preview });
      render(
        <DockerCleanupReview open onOpenChange={() => undefined} onFinished={() => undefined} />,
      );
      await screen.findByText("Can be removed (2)");
      expect(screen.queryByText(/Older containers/)).toBeNull();
      expect(screen.queryByText(/did not answer/)).toBeNull();
    });

    test("lists each one with what it exposes and a Rebuild action per environment", async () => {
      install({ docker_cleanup_preview: () => withLegacy });
      render(
        <DockerCleanupReview open onOpenChange={() => undefined} onFinished={() => undefined} />,
      );
      await screen.findByText("Older containers to rebuild (2)");
      expect(screen.getByText("Old environment")).toBeTruthy();
      expect(screen.getAllByText(/agent home directories are mounted/)).toHaveLength(2);
      expect(screen.getByText(/shares a Docker network/)).toBeTruthy();
      const rebuild = screen.getByRole("button", { name: "Rebuild Old environment" });
      expect((rebuild as HTMLButtonElement).disabled).toBe(false);
      // An operation already running for the other one is shown, not interrupted.
      const busy = screen.getByRole("button", { name: "Rebuild Other environment" });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      expect(busy.textContent).toBe("Busy");
      // The list only ever offers a rebuild: nothing joins the removal selection.
      expect(screen.getByRole("button", { name: "Remove 2 selected" })).toBeTruthy();
    });

    test("says when Docker did not answer for a container", async () => {
      install({
        docker_cleanup_preview: () => ({
          ...preview,
          legacyRuntimes: [],
          legacyRuntimesUnchecked: 2,
        }),
      });
      render(
        <DockerCleanupReview open onOpenChange={() => undefined} onFinished={() => undefined} />,
      );
      await screen.findByText(/Docker did not answer for 2 environments' containers/);
    });

    test("Rebuild confirms what is kept, then runs the preserving rebuild", async () => {
      const recreate = mock((_args: Record<string, unknown>) => undefined);
      const reads: string[] = [];
      install({
        docker_cleanup_preview: () => {
          reads.push("preview");
          return reads.length === 1 ? withLegacy : { ...preview, legacyRuntimes: [] };
        },
        get_rebuild_preview: () => rebuildPreview,
        recreate_environment: recreate,
        get_container_lifecycle_snapshot: succeeded,
      });
      const onFinished = mock(() => undefined);
      render(<DockerCleanupReview open onOpenChange={() => undefined} onFinished={onFinished} />);
      fireEvent.click(await screen.findByRole("button", { name: "Rebuild Old environment" }));
      await screen.findByText("Rebuild container and keep its files?");
      expect(screen.getByText(/tracked, untracked and ignored files/)).toBeTruthy();
      expect(recreate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
      await waitFor(() => expect(recreate).toHaveBeenCalledTimes(1));
      expect(recreate.mock.calls[0]?.[0]).toEqual({
        environmentId: "env-old",
        intent: "preserve",
        expectedContainerId: "old-container",
      });
      await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
      // The review reads again, so the rebuilt environment leaves the list.
      await waitFor(() => expect(screen.queryByText(/Older containers/)).toBeNull());
      expect(invokeMock.mock.calls.some(([command]) => command === "docker_cleanup_execute")).toBe(
        false,
      );
    });

    test("an unavailable rebuild says why and offers nothing to run", async () => {
      const recreate = mock((_args: Record<string, unknown>) => undefined);
      install({
        docker_cleanup_preview: () => withLegacy,
        get_rebuild_preview: () => ({
          ...rebuildPreview,
          available: false,
          unavailableReason: "image-without-storage-contract",
        }),
        recreate_environment: recreate,
      });
      render(
        <DockerCleanupReview open onOpenChange={() => undefined} onFinished={() => undefined} />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Rebuild Old environment" }));
      await screen.findByText(/too old to rebuild from/);
      expect(screen.queryByRole("button", { name: "Rebuild" })).toBeNull();
      expect(recreate).not.toHaveBeenCalled();
    });

    test("a rebuild the backend refuses reports that the original was kept", async () => {
      const failure = spyOn(toast, "error").mockImplementation(() => "toast");
      install({
        docker_cleanup_preview: () => withLegacy,
        get_rebuild_preview: () => rebuildPreview,
        recreate_environment: () => {
          throw new Error("ContainerLifecycleError:capability-unavailable: The image is too old.");
        },
      });
      const onFinished = mock(() => undefined);
      render(<DockerCleanupReview open onOpenChange={() => undefined} onFinished={onFinished} />);
      fireEvent.click(await screen.findByRole("button", { name: "Rebuild Old environment" }));
      fireEvent.click(await screen.findByRole("button", { name: "Rebuild" }));
      await waitFor(() =>
        expect(failure).toHaveBeenCalledWith("Rebuild did not complete", {
          description: "The image is too old. The original container was kept.",
        }),
      );
      failure.mockRestore();
    });
  });
});
