import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EnvironmentInputStatus } from "@orkestrator/protocol/container-recovery";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { EnvironmentInputsSection } from "./EnvironmentInputsSection";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handlers[command]?.(args),
  );
}

const staged: EnvironmentInputStatus = {
  environmentId: "env-inputs",
  mode: "staged",
  revision: "r1-abcdef01",
  stagedAt: new Date(0).toISOString(),
  providers: [
    { provider: "claude", files: 3, bytes: 2048, skipped: { symlink: 1 } },
    { provider: "git", files: 1, bytes: 40, skipped: {} },
  ],
  missingProviders: ["codex"],
  disabledProviders: [],
  revokedProviders: [],
};

describe("environment inputs section", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("shows what was staged and what a rebuild would add", async () => {
    install({ get_environment_inputs: () => staged });
    render(<EnvironmentInputsSection environmentId="env-inputs" dockerAvailable />);
    await screen.findByText(/Claude Code · 3 files/);
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
    expect(screen.getByText(/Enabled since this container was created: Codex/)).toBeTruthy();
  });

  test("explains a legacy container's whole-home mounts", async () => {
    install({ get_environment_inputs: () => ({ ...staged, mode: "host-mounts", providers: [] }) });
    render(<EnvironmentInputsSection environmentId="env-inputs" dockerAvailable />);
    await screen.findByText(/home directories mounted read-only/);
  });

  test("removing credentials reports a pending rebuild honestly", async () => {
    const revoke = mock((_args: Record<string, unknown>) => ({
      provider: "claude",
      removed: true,
      pendingRebuild: true,
      processesStopped: true,
    }));
    install({ get_environment_inputs: () => staged, revoke_provider_credentials: revoke });
    render(<EnvironmentInputsSection environmentId="env-inputs" dockerAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove credentials" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(revoke.mock.calls[0]?.[0]).toEqual({ environmentId: "env-inputs", provider: "claude" });
  });

  test("a revoked provider is listed apart and can be allowed again", async () => {
    const restore = mock((_args: Record<string, unknown>) => ({
      provider: "claude",
      pendingRebuild: true,
    }));
    install({
      get_environment_inputs: () => ({ ...staged, revokedProviders: ["claude"] }),
      restore_provider_credentials: restore,
    });
    render(<EnvironmentInputsSection environmentId="env-inputs" dockerAvailable />);
    await screen.findByText(/Claude Code · revoked for this environment/);
    expect(screen.queryAllByRole("button", { name: "Remove credentials" })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Allow again" }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  });
});
