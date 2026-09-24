import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { mcpFailure, type McpRuntimeApplyEntry } from "@orkestrator/protocol/mcp-management";

import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { mockToastError } from "../../../../../../tests/mocks/sonner";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

import { McpApplyStatus, partialOutcomeText } from "./McpApplyStatus";
import {
  baseHandlers,
  callsOf,
  definition,
  install,
  operation,
  preview,
  resetInvoke,
  snapshot,
  target,
} from "./mcp-test-fixtures";
import { ProviderMcpSettings } from "./ProviderMcpSettings";

afterEach(() => {
  cleanup();
  resetInvoke();
});

function runtime(
  runtimeId: string,
  state: McpRuntimeApplyEntry["state"],
  reason?: string,
): McpRuntimeApplyEntry {
  return {
    runtimeId,
    environmentId: "e1",
    label: `Session ${runtimeId}`,
    state,
    ...(reason ? { reason } : {}),
    updatedAt: "2026-09-23T00:00:00Z",
  };
}

describe("apply status", () => {
  test("a partial outcome summarises mixed sessions and lists each one", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: {
              state: "failed",
              runtimes: [
                runtime("a", "applied"),
                runtime("b", "pending-next-turn"),
                runtime("c", "failed", "The bridge rejected the reload."),
              ],
              omitted: 0,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Saved; loaded in 1 of 3 sessions, 1 waiting, 1 failed")).toBeTruthy();
    const sessions = screen.getByLabelText("Sessions affected by docs");
    expect(within(sessions).getByText("Session b")).toBeTruthy();
    expect(within(sessions).getByText(/The bridge rejected the reload/)).toBeTruthy();
  });

  test("a session that moved on to a later save says so, and affected environments are named", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            savedRevision: "r1.two",
            affectedEnvironments: [{ environmentId: "e1", name: "feature-x", activeSessions: 1 }],
            apply: {
              state: "pending-next-turn",
              runtimes: [{ ...runtime("a", "pending-next-turn"), savedRevision: "r1.three" }],
              omitted: 0,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/now tracking a later saved change/)).toBeTruthy();
    expect(screen.getByText("Environments: feature-x")).toBeTruthy();
  });

  test("partialOutcomeText counts omitted sessions and is silent when all agree", () => {
    expect(partialOutcomeText([runtime("a", "applied"), runtime("b", "applied")])).toBeNull();
    expect(partialOutcomeText([runtime("a", "applied"), runtime("b", "queued")], 3)).toBe(
      "Saved; loaded in 1 of 5 sessions, 1 waiting",
    );
  });

  test("loaded is not presented as connected: health points at the live panel", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: { state: "applied", runtimes: [runtime("a", "applied")], omitted: 0 },
          }),
        ]}
      />,
    );
    expect(screen.getAllByText("Saved and loaded").length).toBeGreaterThan(0);
    expect(screen.getByText(/live connection and sign-in status/)).toBeTruthy();
    expectDomAbsent(screen.queryByText(/connected successfully/i), "connection claim");
  });

  test("pending next turn does not claim the server is loaded or applied", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: {
              state: "pending-next-turn",
              runtimes: [runtime("a", "pending-next-turn")],
              omitted: 0,
            },
          }),
        ]}
      />,
    );
    const texts = screen.getAllByText("Saved; not loaded until the session's next message");
    expect(texts.length).toBeGreaterThan(0);
    expectDomAbsent(screen.queryByText(/applied|Saved and loaded/i), "success claim");
    expectDomAbsent(screen.queryByText(/live connection and sign-in status/), "health pointer");
  });

  test("retry apply re-applies the saved operation and never re-saves", async () => {
    install({ apply_mcp_configuration: () => operation() });
    render(
      <McpApplyStatus
        operations={[
          operation({
            operationId: "op-retry",
            apply: { state: "failed", runtimes: [runtime("a", "failed")], omitted: 0 },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
    await waitFor(() => expect(callsOf("apply_mcp_configuration").length).toBe(1));
    expect(callsOf("apply_mcp_configuration")[0]).toEqual({ operationId: "op-retry" });
    expect(callsOf("mutate_mcp_definition").length).toBe(0);
  });

  test("cancel apply cancels the queued operation, keeping what was saved", async () => {
    install({ cancel_mcp_apply: () => operation() });
    render(
      <McpApplyStatus
        operations={[
          operation({
            operationId: "op-queued",
            apply: { state: "queued", runtimes: [runtime("a", "queued")], omitted: 0 },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel apply" }));
    await waitFor(() => expect(callsOf("cancel_mcp_apply").length).toBe(1));
    expect(callsOf("cancel_mcp_apply")[0]).toEqual({ operationId: "op-queued" });
    expect(callsOf("mutate_mcp_definition").length).toBe(0);
  });

  test("a failed retry reports its reference", async () => {
    install({
      apply_mcp_configuration: () => {
        throw mcpFailure("apply-failed", { correlationId: "corr-apply" });
      },
    });
    render(
      <McpApplyStatus
        operations={[
          operation({ apply: { state: "failed", runtimes: [runtime("a", "failed")], omitted: 0 } }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(String(mockToastError.mock.calls[0]?.[0])).toContain("Reference: corr-apply");
  });
});

describe("catalog states", () => {
  test("an empty target says so instead of showing nothing", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () => snapshot({ sources: [], definitions: [], effective: {} }),
    });
    render(<ProviderMcpSettings />);
    expect(await screen.findByText(/No configuration files were found/)).toBeTruthy();
  });

  test("a writable source with no servers lists none and still offers Add", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () => snapshot({ definitions: [], effective: {} }),
    });
    render(<ProviderMcpSettings />);
    expect(await screen.findByText("No servers.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Add server/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("an offline container target is read-only with its reason", async () => {
    const offline = {
      ...target,
      targetId: "mcp1~claude~env~c1~x",
      context: {
        kind: "environment" as const,
        environmentId: "c1",
        location: "container" as const,
        locationLabel: "Container c1",
      },
      readOnlyReason: "The container is stopped. Start it to edit its servers.",
    };
    install({
      list_mcp_management_targets: () => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: [target, offline],
      }),
      get_mcp_management_snapshot: () =>
        snapshot({
          target: offline,
          sources: [
            {
              ...snapshot().sources[0]!,
              sourceId: "claude:project",
              state: "offline",
              writable: false,
              readOnlyReason: "The container is stopped.",
              revision: null,
            },
          ],
          definitions: [],
          effective: {},
        }),
    });
    requestMcpServerSettings({ provider: "claude", environmentId: "c1" });
    render(<ProviderMcpSettings />);
    expect(await screen.findByRole("note")).toBeTruthy();
    expect(screen.getByText(/The container is stopped. Start it/)).toBeTruthy();
    expect(screen.getByText(/Not reachable/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Add server/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a deep link naming a server highlights its row", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({ definitions: [definition(), definition({ entryId: "e2", name: "other" })] }),
    });
    requestMcpServerSettings({ provider: "claude", serverName: "docs" });
    render(<ProviderMcpSettings />);
    const row = await screen.findByRole("listitem", { name: "docs, In use" });
    expect(row.className).toContain("bg-blue-500/10");
    expect(screen.getByRole("listitem", { name: "other, In use" }).className).not.toContain(
      "bg-blue-500/10",
    );
  });

  test("very long names and paths wrap or truncate instead of overflowing", async () => {
    const longName = `server-${"x".repeat(240)}`;
    const longCommand = `/opt/${"deep/".repeat(60)}bin/run`;
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({
          sources: [{ ...snapshot().sources[0]!, displayPath: `~/${"nested/".repeat(50)}x.json` }],
          definitions: [
            definition({ name: longName, command: { kind: "visible", value: longCommand } }),
          ],
          operations: [operation({ entryName: longName })],
        }),
    });
    render(<ProviderMcpSettings />);
    const name = await screen.findByText(longName, { selector: "span.font-mono.text-sm" });
    expect(name.className).toContain("break-all");
    // The row's text column can shrink below its content.
    expect(name.closest("div.min-w-0")).toBeTruthy();
    const location = screen.getByText(`${longCommand} +1 arg`);
    expect(location.className).toContain("truncate");
    expect(location.getAttribute("title")).toBe(`${longCommand} +1 arg`);
    expect(screen.getByText(/nested\/nested/).className).toContain("break-all");
    const operationName = within(screen.getByRole("region", { name: "Recent changes" })).getByText(
      longName,
    );
    expect(operationName.parentElement?.className).toContain("break-all");
    // Row actions stay reachable next to the long name.
    expect(screen.getByRole("button", { name: `Edit ${longName}` })).toBeTruthy();
  });
});

describe("rollout gate", () => {
  const writeReason = "Changing Claude Code MCP configuration is not enabled on this backend.";
  const applyReason =
    "Applying Claude Code MCP changes to running sessions is not enabled on this backend.";
  const denied = (reason: string) => ({ supported: false, reason });

  function gatedTarget(gate: { write?: string; apply?: string }) {
    return {
      ...target,
      capabilities: {
        ...target.capabilities,
        operations: gate.write
          ? {
              add: denied(gate.write),
              update: denied(gate.write),
              rename: denied(gate.write),
              remove: denied(gate.write),
              setEnabled: denied(gate.write),
            }
          : target.capabilities.operations,
        rollout: {
          write: gate.write ? denied(gate.write) : { supported: true },
          apply: gate.apply ? denied(gate.apply) : { supported: true },
        },
      },
    };
  }

  function installGated(gate: { write?: string; apply?: string }, extra = {}) {
    const gated = gatedTarget(gate);
    install({
      list_mcp_management_targets: () => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: [gated],
      }),
      get_mcp_management_snapshot: () =>
        snapshot({
          target: gated,
          operations: [
            operation({
              operationId: "op-failed",
              apply: { state: "failed", runtimes: [runtime("a", "failed")], omitted: 0 },
            }),
            operation({
              operationId: "op-queued",
              apply: { state: "queued", runtimes: [runtime("b", "queued")], omitted: 0 },
            }),
          ],
        }),
      ...extra,
    });
  }

  test("writes switched off: Add is disabled and the reason is shown", async () => {
    installGated({ write: writeReason });
    render(<ProviderMcpSettings />);
    const add = (await screen.findByRole("button", { name: /Add server/ })) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("title")).toBe(writeReason);
    expect(screen.getAllByText(writeReason).length).toBeGreaterThan(0);
  });

  test("applying switched off: only Save is offered and no apply can be started", async () => {
    installGated(
      { apply: applyReason },
      { validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }) },
    );
    render(<ProviderMcpSettings />);
    expect(await screen.findByText(applyReason)).toBeTruthy();
    // Recent changes: retry is not offered, cancelling queued work still is.
    expectDomAbsent(screen.queryByRole("button", { name: "Retry apply" }), "retry apply");
    expect(screen.getByRole("button", { name: "Cancel apply" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByLabelText("Change preview");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expectDomAbsent(screen.queryByRole("button", { name: "Save and apply" }), "save and apply");
    expect(callsOf("validate_mcp_mutation")[0]!.mutation.applyIntent).toBe("save");
  });

  test("a flattened backend error carries its reference to the notice", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    install({
      ...baseHandlers,
      mutate_mcp_definition: () => {
        throw new Error("McpManagementError:internal: The change failed. [ref:abc-123]");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("abc-123")).toBeTruthy();
    expect(screen.getByText("The change failed.")).toBeTruthy();
    expectDomAbsent(screen.queryByText(/\[ref:/), "raw reference suffix");
  });
});
