import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { mcpFailure, type McpEnvironmentOverlayState } from "@orkestrator/protocol/mcp-management";

import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { mockToastSuccess, mockToastWarning } from "../../../../../../tests/mocks/sonner";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

import {
  callsOf,
  containerHandlers,
  containerTarget,
  definition,
  environmentSource,
  install,
  overlay,
  refreshPreview,
  resetInvoke,
  snapshot,
  type Handlers,
} from "./mcp-test-fixtures";
import { ProviderMcpSettings } from "./ProviderMcpSettings";

afterEach(() => {
  cleanup();
  resetInvoke();
  mockToastSuccess.mockClear();
  mockToastWarning.mockClear();
});

const projectSource = () => ({
  ...snapshot().sources[0]!,
  sourceId: "claude:project",
  scope: "project" as const,
  owner: "native-project" as const,
  label: "Project (this worktree)",
  displayPath: "/workspace/.mcp.json",
  precedence: 20,
  writable: false,
  readOnlyReason: "Project files in this container are not kept across rebuilds.",
  revision: "p.rev",
});

/** Open the container target with one environment-private source carrying `state`. */
async function renderOverlay(state: McpEnvironmentOverlayState | undefined, extra: Handlers = {}) {
  install(
    containerHandlers(
      () => ({ sources: [environmentSource(state ? { overlay: state } : {}), projectSource()] }),
      extra,
    ),
  );
  requestMcpServerSettings({ provider: "claude", environmentId: "c1" });
  render(<ProviderMcpSettings />);
  return await screen.findByLabelText("This environment: this environment's changes");
}

const resolved = () => ({ sourceRevision: "c1.rev2", overlay: overlay() });

async function expectResolved(kind: string, extra: Record<string, unknown> = {}, index = 0) {
  await waitFor(() => expect(callsOf("resolve_mcp_environment_overlay").length).toBe(index + 1));
  expect(callsOf("resolve_mcp_environment_overlay")[index]).toEqual({
    resolution: {
      targetId: containerTarget.targetId,
      sourceId: "claude:env",
      expectedRevision: "c1.rev",
      action: { kind, ...extra },
    },
  });
}

/** The action re-read the snapshot through the page's own refresh path. */
async function expectReloaded(before: number) {
  await waitFor(() =>
    expect(callsOf("get_mcp_management_snapshot").length).toBeGreaterThan(before),
  );
}

describe("environment overlay states", () => {
  test("in sync: the changed names are listed and only reset is offered", async () => {
    const panel = await renderOverlay(
      overlay({ added: ["files"], replaced: ["docs"], removed: ["legacy"] }),
    );
    expect(within(panel).getByText("Applied in the container")).toBeTruthy();
    expect(within(panel).getByText("files")).toBeTruthy();
    expect(within(panel).getByText("docs")).toBeTruthy();
    expect(within(panel).getByText("legacy")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Reset to inherited/ })).toBeTruthy();
    expectDomAbsent(within(panel).queryByRole("button", { name: /Import/ }), "import");
    expectDomAbsent(within(panel).queryByRole("button", { name: /Reapply/ }), "reapply");
  });

  test("pending offers reapply (not import), which resolves and reloads", async () => {
    const panel = await renderOverlay(overlay({ state: "pending", added: ["files"] }), {
      resolve_mcp_environment_overlay: resolved,
    });
    expect(within(panel).getByText("Not in the container yet")).toBeTruthy();
    expectDomAbsent(within(panel).queryByRole("button", { name: /Import/ }), "import");
    const before = callsOf("get_mcp_management_snapshot").length;
    fireEvent.click(
      within(panel).getByRole("button", { name: "Reapply this environment's changes" }),
    );
    await expectResolved("reapply");
    await expectReloaded(before);
    expect(String(mockToastSuccess.mock.calls[0]?.[0])).toContain("Reapplied");
  });

  test("diverged names the edited servers and offers import and reapply", async () => {
    const panel = await renderOverlay(
      overlay({ state: "diverged", replaced: ["docs"], divergedNames: ["docs", "extra"] }),
      { resolve_mcp_environment_overlay: resolved },
    );
    expect(within(panel).getByText("Edited inside the container")).toBeTruthy();
    expect(within(panel).getByText("docs, extra")).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Reapply this environment's changes" }),
    ).toBeTruthy();
    const before = callsOf("get_mcp_management_snapshot").length;
    fireEvent.click(within(panel).getByRole("button", { name: "Import container edits" }));
    await expectResolved("import");
    await expectReloaded(before);
  });

  test("conflict: each name can keep this environment's version or take the inherited one", async () => {
    const panel = await renderOverlay(
      overlay({
        state: "conflict",
        replaced: ["docs", "files"],
        conflicts: [
          { name: "docs", reason: "The backend user changed docs." },
          { name: "files", reason: "The backend user removed files." },
        ],
      }),
      { resolve_mcp_environment_overlay: resolved },
    );
    const conflicts = within(panel).getByRole("list", { name: "Conflicting servers" });
    expect(within(conflicts).getByText(/The backend user changed docs/)).toBeTruthy();
    expect(within(conflicts).getByText(/The backend user removed files/)).toBeTruthy();
    fireEvent.click(
      within(conflicts).getByRole("button", { name: "Keep this environment's version of docs" }),
    );
    await expectResolved("keep-environment", { name: "docs" });

    const takeFiles = within(conflicts).getByRole("button", {
      name: "Use the inherited files",
    }) as HTMLButtonElement;
    // Every action is disabled while one is in flight.
    await waitFor(() => expect(takeFiles.disabled).toBe(false));
    fireEvent.click(takeFiles);
    await expectResolved("take-inherited", { name: "files" }, 1);
  });

  test("reset asks first; cancelling sends nothing and confirming resets", async () => {
    const panel = await renderOverlay(overlay({ added: ["files"] }), {
      resolve_mcp_environment_overlay: () => ({ sourceRevision: "c1.rev2", overlay: null }),
    });
    fireEvent.click(within(panel).getByRole("button", { name: /Reset to inherited/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Reset to the inherited servers?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep changes" }));
    await waitFor(() => expectDomAbsent(screen.queryByRole("alertdialog"), "reset dialog"));
    expect(callsOf("resolve_mcp_environment_overlay").length).toBe(0);

    fireEvent.click(within(panel).getByRole("button", { name: /Reset to inherited/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reset" }),
    );
    await expectResolved("reset");
  });

  test("a refused action shows its message and still reloads the snapshot", async () => {
    const panel = await renderOverlay(
      overlay({ state: "conflict", conflicts: [{ name: "docs", reason: "Changed upstream." }] }),
      {
        resolve_mcp_environment_overlay: () => {
          throw mcpFailure("environment-diverged", { correlationId: "corr-ov" });
        },
      },
    );
    const before = callsOf("get_mcp_management_snapshot").length;
    fireEvent.click(within(panel).getByRole("button", { name: "Use the inherited docs" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("edited inside the container");
    expect(alert.textContent).toContain("corr-ov");
    await expectReloaded(before);
  });

  test("an offline container disables the actions with its reason", async () => {
    const offline = { ...containerTarget, readOnlyReason: "The container is stopped." };
    install({
      ...containerHandlers(() => ({
        target: offline,
        sources: [environmentSource({ overlay: overlay({ state: "pending" }) })],
      })),
      list_mcp_management_targets: () => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: [offline],
      }),
    });
    requestMcpServerSettings({ provider: "claude", environmentId: "c1" });
    render(<ProviderMcpSettings />);
    const reapply = (await screen.findByRole("button", {
      name: "Reapply this environment's changes",
    })) as HTMLButtonElement;
    expect(reapply.disabled).toBe(true);
    expect(reapply.title).toBe("The container is stopped.");
    const refresh = screen.getByRole("button", {
      name: /Refresh from backend user/,
    }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
  });
});

describe("refresh from the backend user", () => {
  test("only the container's environment-private source offers it", async () => {
    await renderOverlay(undefined);
    expect(screen.getAllByRole("button", { name: /Refresh from backend user/ }).length).toBe(1);
    const project = screen.getByRole("region", { name: "Project (this worktree)" });
    expectDomAbsent(
      within(project).queryByRole("button", { name: /Refresh from backend user/ }),
      "project refresh",
    );
  });

  test("the preview lists every change, and confirming refreshes with its token", async () => {
    await renderOverlay(overlay({ added: ["mine"] }), {
      preview_mcp_environment_defaults: () =>
        refreshPreview({
          unchanged: false,
          added: ["new-one"],
          changed: ["docs"],
          removed: ["gone"],
          diverged: ["edited"],
          conflicts: [{ name: "mine", reason: "The backend user added mine too." }],
          warnings: ["Refreshing overwrites the edits made inside the container."],
        }),
      refresh_mcp_environment_defaults: () => ({ ...resolved(), stagedCopy: "updated" }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Refresh from backend user/ }));
    const dialog = await screen.findByRole("dialog");
    const previewBox = await within(dialog).findByLabelText("Refresh preview");
    for (const text of ["new-one", "docs", "gone", "edited"])
      expect(within(previewBox).getByText(text)).toBeTruthy();
    expect(within(previewBox).getByText(/The backend user added mine too/)).toBeTruthy();
    expect(within(previewBox).getByText(/overwrites the edits/)).toBeTruthy();
    expect(callsOf("preview_mcp_environment_defaults")[0]).toEqual({
      request: { targetId: containerTarget.targetId, sourceId: "claude:env" },
    });

    const before = callsOf("get_mcp_management_snapshot").length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsOf("refresh_mcp_environment_defaults").length).toBe(1));
    expect(callsOf("refresh_mcp_environment_defaults")[0]).toEqual({
      request: {
        targetId: containerTarget.targetId,
        sourceId: "claude:env",
        previewToken: "tok-1",
      },
    });
    await expectReloaded(before);
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "refresh dialog"));
    expect(String(mockToastSuccess.mock.calls[0]?.[0])).toContain("Refreshed");
  });

  test("a stale token is refused; previewing again sends the new token", async () => {
    let previews = 0;
    let refreshes = 0;
    await renderOverlay(undefined, {
      preview_mcp_environment_defaults: () =>
        refreshPreview({ unchanged: false, added: ["new-one"], previewToken: `tok-${++previews}` }),
      refresh_mcp_environment_defaults: () => {
        if (++refreshes === 1) throw mcpFailure("revision-conflict");
        return { ...resolved(), stagedCopy: "unavailable" };
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Refresh from backend user/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByLabelText("Refresh preview");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "changed since it was loaded",
    );
    // The stale preview is gone: nothing can be submitted with its token.
    expectDomAbsent(within(dialog).queryByRole("button", { name: "Refresh" }), "stale refresh");
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview again" }));
    await within(dialog).findByLabelText("Refresh preview");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsOf("refresh_mcp_environment_defaults").length).toBe(2));
    expect(
      callsOf("refresh_mcp_environment_defaults").map((call) => call.request.previewToken),
    ).toEqual(["tok-1", "tok-2"]);
    // The copy a rebuild starts from could not be updated: say so.
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
  });

  test("an unchanged preview says there is nothing to refresh", async () => {
    await renderOverlay(undefined, {
      preview_mcp_environment_defaults: () => refreshPreview({ unchanged: true }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Refresh from backend user/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Nothing to refresh/)).toBeTruthy();
    expectDomAbsent(within(dialog).queryByRole("button", { name: "Refresh" }), "refresh button");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "refresh dialog"));
    expect(callsOf("refresh_mcp_environment_defaults").length).toBe(0);
  });
});

describe("where a container's servers run", () => {
  test("rows show path-audit warnings", async () => {
    install(
      containerHandlers(() => ({
        sources: [environmentSource()],
        definitions: [
          definition({
            entryId: "claude:env/ZG9jcw",
            sourceId: "claude:env",
            command: { kind: "visible", value: "/Users/me/bin/docs" },
            warnings: ["/Users/me/bin/docs does not exist in this container."],
          }),
        ],
      })),
    );
    requestMcpServerSettings({ provider: "claude", environmentId: "c1" });
    render(<ProviderMcpSettings />);
    const warnings = await screen.findByRole("list", { name: "Warnings for docs" });
    expect(within(warnings).getByText(/does not exist in this container/)).toBeTruthy();
  });

  test("the URL field says where it connects from, and why sign-in is not offered", async () => {
    install(containerHandlers(() => ({ sources: [environmentSource()] })));
    requestMcpServerSettings({ provider: "claude", environmentId: "c1" });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
    expect(screen.getByText(/It runs on container of env-a when/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(
      screen.getByText("Connects from Container of env-a, not from this browser."),
    ).toBeTruthy();
    expect(screen.getByText(/Sign-in: Sign in from a session in this container/)).toBeTruthy();
  });

  test("a save refused as environment-diverged shows why and reloads the list", async () => {
    install(
      containerHandlers(() => ({ sources: [environmentSource()] }), {
        validate_mcp_mutation: () => {
          throw mcpFailure("environment-diverged");
        },
      }),
    );
    requestMcpServerSettings({ provider: "claude", environmentId: "c1" });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    const before = callsOf("get_mcp_management_snapshot").length;
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByText(/edited inside the container after Orkestrator/)).toBeTruthy();
    await expectReloaded(before);
  });
});
