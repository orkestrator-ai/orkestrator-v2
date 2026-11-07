import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as federation from "@/components/federation/FederationProvider";
import { resetCapabilities } from "@/lib/design-client";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import type { Environment } from "@/types";
import { LocalEnvironmentDeleteDialog } from "./LocalEnvironmentDeleteDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const environment: Environment = {
  id: "env-delete-dialog",
  projectId: "project-1",
  name: "feature-env",
  branch: "feature/dialog",
  containerId: null,
  status: "stopped",
  prUrl: null,
  prState: null,
  hasMergeConflicts: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
  worktreePath: "/fixture/feature-env",
};

beforeEach(() => resetCapabilities());
afterEach(() => {
  cleanup();
  mock.restore();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  resetCapabilities();
});

function openDialog(overrides: Partial<Environment> = {}) {
  const onCancel = mock(() => {});
  const onConfirm = mock(() => {});
  renderInAppCommandScope(
    <LocalEnvironmentDeleteDialog
      environment={{ ...environment, ...overrides }}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

describe("LocalEnvironmentDeleteDialog warning parity", () => {
  test("names the owning machine in the confirmation, worktree warning and action", () => {
    spyOn(federation, "useFederation").mockReturnValue({
      portal: portalStore,
      portalState: portalStore.getState(),
      bound: null,
      supported: true,
      enabled: false,
      kind: "browser",
      boundMachine: { name: "Build Mac", colorToken: "teal" },
    });
    const { onConfirm } = openDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Are you sure you want to delete feature-env on Build Mac?",
    );
    expect(dialog.textContent).toContain("This will delete the git worktree from Build Mac.");
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete on Build Mac" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("warns that local deletion removes the worktree from your machine", () => {
    openDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("This will delete the git worktree from your machine.");
    expect(dialog.textContent).not.toContain("Its container");
    expect(dialog.textContent).not.toContain("It will be stopped before deletion.");
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  test("explains that an associated pull request remains open", () => {
    openDialog({ prUrl: "https://github.com/org/repo/pull/1", prState: "open" });
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "This environment has an associated PR that will remain open.",
    );
  });

  test("loads and shows design loss warnings for the target environment", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "design_capabilities")
        return { ok: true, value: { protocolVersion: 2, library: true } };
      if (command === "design_library")
        return {
          ok: true,
          value: { entries: [{ id: "design-1", state: "live" }], total: 1 },
        };
      throw new Error(`Unexpected command: ${command}`);
    });
    const { onConfirm } = openDialog();
    const notice = await screen.findByTestId("design-deletion-notice");
    expect(screen.getByRole("alertdialog").contains(notice)).toBe(true);
    expect(notice.textContent).toContain("1 design in its workspace, which will be deleted");
    expect(notice.textContent).toContain("1 has changes that were never exported");
    expect(notice.textContent).toContain("Export or download any design you want to keep first.");
    expect(invokeMock).toHaveBeenCalledWith(
      "design_library",
      expect.objectContaining({ environmentId: environment.id }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
