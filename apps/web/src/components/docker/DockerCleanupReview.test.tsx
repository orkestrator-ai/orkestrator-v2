import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
