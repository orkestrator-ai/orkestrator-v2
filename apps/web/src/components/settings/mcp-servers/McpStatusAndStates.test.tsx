import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { mcpFailure, type McpRuntimeApplyEntry } from "@orkestrator/protocol/mcp-management";

import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { mockToastError } from "../../../../../../tests/mocks/sonner";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

import { McpApplyStatus, omittedText, partialOutcomeText } from "./McpApplyStatus";
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
    expect(
      partialOutcomeText([runtime("a", "applied"), runtime("b", "queued")], 3, { queued: 3 }),
    ).toBe("Saved; loaded in 1 of 5 sessions, 4 waiting");
    // Unlisted sessions in the same state as every listed one: still one state.
    expect(partialOutcomeText([runtime("a", "applied")], 2, { applied: 2 })).toBeNull();
    // An unlisted session that is still waiting makes the outcome partial.
    expect(partialOutcomeText([runtime("a", "applied")], 2, { applied: 1, queued: 1 })).toBe(
      "Saved; loaded in 2 of 3 sessions, 1 waiting",
    );
  });

  test("sessions past what one apply tracks are named, never folded into loaded", () => {
    // Without per-state counts every omitted session is untracked (an older backend dropped them).
    expect(partialOutcomeText([runtime("a", "applied")], 3)).toBe(
      "Saved; loaded in 1 of 4 sessions, 3 not tracked",
    );
    expect(omittedText(70, { applied: 60, "pending-next-turn": 4 })).toBe(
      "…and 70 more: 60 loaded, 4 waiting, 6 not tracked",
    );
    expect(omittedText(2, { failed: 1, "restart-required": 1 })).toBe(
      "…and 2 more: 1 failed, 1 need attention",
    );
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: {
              state: "applied",
              runtimes: [runtime("a", "applied")],
              omitted: 5,
              omittedStates: { applied: 3 },
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Saved; loaded in 4 of 6 sessions, 2 not tracked")).toBeTruthy();
    expect(screen.getByText("…and 5 more: 3 loaded, 2 not tracked")).toBeTruthy();
    expect(screen.getByText(/were not scheduled/)).toBeTruthy();
  });

  test("an operation whose unlisted sessions are all tracked does not claim any were dropped", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: {
              state: "pending-next-turn",
              runtimes: [runtime("a", "pending-next-turn")],
              omitted: 2,
              omittedStates: { "pending-next-turn": 2 },
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("…and 2 more: 2 waiting")).toBeTruthy();
    expectDomAbsent(screen.queryByText(/not tracked|were not scheduled/), "untracked claim");
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

  test.each(["superseded-external", "superseded-local"] as const)(
    "a runtime cancelled as %s offers no retry, only how to save it again",
    (cancelReason) => {
      render(
        <McpApplyStatus
          operations={[
            operation({
              apply: {
                state: "cancelled",
                runtimes: [
                  { ...runtime("a", "cancelled", "The file no longer holds it."), cancelReason },
                  runtime("b", "failed"),
                ],
                omitted: 0,
              },
            }),
          ]}
        />,
      );
      // A failed runtime beside it does not bring Retry back: the change itself is gone.
      expectDomAbsent(screen.queryByRole("button", { name: "Retry apply" }), "retry apply");
      expect(
        screen.getByText(/Nothing to retry: the file no longer holds this change/),
      ).toBeTruthy();
      expect(screen.getByText(/save the change again/)).toBeTruthy();
    },
  );

  test("any other cancellation keeps Retry and shows no hint", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: {
              state: "cancelled",
              runtimes: [
                runtime("a", "cancelled", "Cancelled; the saved configuration is unchanged."),
              ],
              omitted: 0,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Retry apply" })).toBeTruthy();
    expectDomAbsent(screen.queryByText(/Nothing to retry/), "superseded hint");
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

describe("actions for sessions past the listed page", () => {
  test("a queued session that is only counted still offers Cancel apply", async () => {
    install({ cancel_mcp_apply: () => operation() });
    render(
      <McpApplyStatus
        operations={[
          operation({
            operationId: "op-hidden-queued",
            apply: {
              state: "queued",
              runtimes: [runtime("a", "pending-next-turn")],
              omitted: 1,
              omittedStates: { queued: 1 },
            },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel apply" }));
    await waitFor(() => expect(callsOf("cancel_mcp_apply").length).toBe(1));
    expect(callsOf("cancel_mcp_apply")[0]).toEqual({ operationId: "op-hidden-queued" });
  });

  test.each(["failed", "cancelled"] as const)(
    "a %s session that is only counted still offers Retry apply",
    async (state) => {
      install({ apply_mcp_configuration: () => operation() });
      render(
        <McpApplyStatus
          operations={[
            operation({
              operationId: "op-hidden-retry",
              apply: {
                state,
                runtimes: [runtime("a", "pending-next-turn")],
                omitted: 1,
                omittedStates: { [state]: 1 },
              },
            }),
          ]}
        />,
      );
      expectDomAbsent(screen.queryByRole("button", { name: "Cancel apply" }), "cancel apply");
      fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
      await waitFor(() => expect(callsOf("apply_mcp_configuration").length).toBe(1));
      expect(callsOf("apply_mcp_configuration")[0]).toEqual({ operationId: "op-hidden-retry" });
    },
  );

  test("a listed superseded session withholds Retry for counted failures too", () => {
    render(
      <McpApplyStatus
        operations={[
          operation({
            apply: {
              state: "cancelled",
              runtimes: [
                {
                  ...runtime("a", "cancelled", "The file no longer holds it."),
                  cancelReason: "superseded-external",
                },
              ],
              omitted: 3,
              omittedStates: { cancelled: 2, failed: 1 },
            },
          }),
        ]}
      />,
    );
    expectDomAbsent(screen.queryByRole("button", { name: "Retry apply" }), "retry apply");
    expect(screen.getByText(/Nothing to retry/)).toBeTruthy();
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

  test("an in-use row shows its reason, and a source shows its layout note", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({
          sources: [
            {
              ...snapshot().sources[0]!,
              note: "This file lists servers without the mcpServers wrapper.",
            },
          ],
          definitions: [
            definition({ statusReason: "Turned on in this project by the override in Project." }),
          ],
        }),
    });
    render(<ProviderMcpSettings />);
    expect(await screen.findByRole("listitem", { name: "docs, In use" })).toBeTruthy();
    expect(screen.getByText("Turned on in this project by the override in Project.")).toBeTruthy();
    expect(
      screen.getByText("This file lists servers without the mcpServers wrapper."),
    ).toBeTruthy();
  });

  test("a Claude source added accounts copy says so above its servers", async () => {
    // Backend text (`claude-account-copies.ts`), sent only while an added
    // Claude account exists.
    const accountNote =
      "Added Claude accounts use their own copy of these servers. Orkestrator replaces each copy with this file's servers when you save here and before it starts Claude on an account, so servers added inside an account's own configuration are overwritten, and Orkestrator sessions do not use them.";
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({ sources: [{ ...snapshot().sources[0]!, note: accountNote }] }),
    });
    render(<ProviderMcpSettings />);
    const source = await screen.findByRole("region", { name: "Backend user" });
    const header = within(source).getByText(accountNote);
    expect(header.closest("header")).toBeTruthy();
    expect(within(source).getByRole("listitem", { name: "docs, In use" })).toBeTruthy();
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

  test("a live row's link highlights only the row its session loads, with its apply outcome", async () => {
    const projectSource = {
      ...snapshot().sources[0]!,
      sourceId: "claude:project",
      scope: "project" as const,
      owner: "native-project" as const,
      label: "Project (this worktree)",
      precedence: 30,
    };
    const environment = {
      ...target,
      context: { ...target.context, kind: "environment" as const, environmentId: "e1" },
    };
    install({
      ...baseHandlers,
      list_mcp_management_targets: () => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: [environment],
      }),
      get_mcp_management_snapshot: () =>
        snapshot({
          target: environment,
          sources: [snapshot().sources[0]!, projectSource],
          definitions: [
            definition({ status: "shadowed", statusReason: "Hidden by Project." }),
            definition({ entryId: "claude:project/ZG9jcw", sourceId: "claude:project" }),
          ],
          operations: [
            operation({
              apply: {
                state: "pending-next-turn",
                runtimes: [
                  {
                    ...runtime("e1\u0000e1:tab-1", "pending-next-turn"),
                  },
                ],
                omitted: 0,
              },
            }),
          ],
        }),
    });
    requestMcpServerSettings({
      provider: "claude",
      environmentId: "e1",
      serverName: "docs",
      serverScope: "project",
      logicalSessionKey: "e1:tab-1",
    });
    render(<ProviderMcpSettings />);
    const note = await screen.findByRole("note", { name: "Server from the live session" });
    expect(note.textContent).toContain("highlighted row in Project (this worktree)");
    expect(note.textContent).toContain("Another row has the same name");
    expect(note.textContent).toContain("Saved; not loaded until the session's next message");
    const rows = screen.getAllByRole("listitem", { name: /^docs,/ });
    expect(rows.filter((row) => row.getAttribute("aria-current") === "true")).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Project (this worktree)" }))
        .getByRole("listitem", { name: /^docs,/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  test.each([false, true])(
    "a live plugin server highlights its read-only row (settings now off: %s)",
    async (disabled) => {
      const disabledReason =
        'Disabled: enabledPlugins["docs@inline"] is false in ~/.claude/settings.json.';
      const pluginSource = {
        ...snapshot().sources[0]!,
        sourceId: "claude:plugin-0123456789abcdef",
        scope: "plugin" as const,
        owner: "plugin" as const,
        label: "Plugin docs",
        displayPath: "~/.claude/plugins/cache/m/docs/1.0.0/.mcp.json",
        precedence: 101,
        writable: false,
        readOnlyReason: "Managed by Claude Code's plugin settings.",
        note: 'enabledPlugins["docs@m"] is false, but Orkestrator passes this plugin to Claude Code directly.',
      };
      const blocked = { supported: false, reason: "Managed by Claude Code's plugin settings." };
      install({
        ...baseHandlers,
        get_mcp_management_snapshot: () =>
          snapshot({
            sources: [pluginSource, snapshot().sources[0]!],
            definitions: [
              definition(),
              definition({
                entryId: "claude:plugin-0123456789abcdef/cGx1Z2lu",
                sourceId: pluginSource.sourceId,
                name: "plugin:docs:search",
                ...(disabled
                  ? { status: "disabled" as const, enabled: false, statusReason: disabledReason }
                  : {}),
                readOnlyReason: blocked.reason,
                actions: { edit: blocked, rename: blocked, remove: blocked, setEnabled: blocked },
              }),
            ],
          }),
      });
      requestMcpServerSettings({
        provider: "claude",
        serverName: "plugin:docs:search",
        serverScope: "plugin",
      });
      render(<ProviderMcpSettings />);
      const note = await screen.findByRole("note", { name: "Server from the live session" });
      expect(note.textContent).toContain("highlighted row in Plugin docs");
      expect(note.textContent).toContain("Plugin servers are read-only here");
      if (disabled) {
        expect(note.textContent).toContain(
          `The files now say the plugin is off (${disabledReason.replace(/\.$/, "")})`,
        );
        expect(note.textContent).toContain(
          "the session loaded it before that changed, or loads it some other way",
        );
      }
      const region = screen.getByRole("region", { name: "Plugin docs" });
      expect(
        within(region)
          .getByRole("listitem", { name: /^plugin:docs:search,/ })
          .getAttribute("aria-current"),
      ).toBe("true");
      expect(region.textContent).toContain("Managed by Claude Code's plugin settings.");
      expect(region.textContent).toContain("passes this plugin to Claude Code directly");
      const regions = screen
        .getAllByRole("region")
        .map((element) => element.getAttribute("aria-label"));
      expect(regions.indexOf("Plugin docs")).toBeGreaterThan(
        regions.indexOf(snapshot().sources[0]!.label),
      );
    },
  );

  test("a live row with no saved entry says where it may come from", async () => {
    install(baseHandlers);
    requestMcpServerSettings({ provider: "claude", serverName: "from-plugin-team" });
    render(<ProviderMcpSettings />);
    const note = await screen.findByRole("note", { name: "Server from the live session" });
    expect(note.textContent).toContain("No saved server named from-plugin-team");
    expectDomAbsent(
      screen.queryAllByRole("listitem").find((row) => row.getAttribute("aria-current")) ?? null,
      "highlighted row",
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
