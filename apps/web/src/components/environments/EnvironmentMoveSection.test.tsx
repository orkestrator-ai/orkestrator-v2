import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as backend from "@/lib/backend";
import { useHostPathPickerStore } from "@/lib/host-path-picker";
import type { Environment } from "@/types";
import { mockToastError, mockToastWarning } from "../../../../../tests/mocks/sonner";
import { EnvironmentMoveSection, environmentMoveBlockedReason } from "./EnvironmentMoveSection";

const environment = (overrides: Partial<Environment> = {}): Environment =>
  ({
    id: "env-1",
    projectId: "p1",
    name: "Feature",
    branch: "feature",
    status: "running",
    environmentType: "local",
    worktreePath: "/trees/app-feature",
    worktreeBaseDir: "/trees",
    agentActivityState: "idle",
    ...overrides,
  }) as Environment;

afterEach(() => {
  cleanup();
  mock.restore();
});

test("moves into a browsed folder after confirmation and reports the settled record", async () => {
  const moved = environment({
    worktreePath: "/disk/app-feature",
    worktreeBaseDir: "/disk",
  });
  const move = spyOn(backend, "moveEnvironment").mockResolvedValue(moved);
  const onUpdate = mock(() => undefined);
  render(<EnvironmentMoveSection environment={environment()} onUpdate={onUpdate} />);

  const field = screen.getByRole("textbox", { name: "Destination folder" }) as HTMLInputElement;
  expect(field.value).toBe("/trees");
  // Moving into the folder it is already in does nothing.
  expect(screen.getByRole("button", { name: "Move…" })).toHaveProperty("disabled", true);

  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect(useHostPathPickerStore.getState().request).toBeTruthy());
  act(() => useHostPathPickerStore.getState().settle("/disk"));
  await waitFor(() => expect(field.value).toBe("/disk"));

  fireEvent.click(screen.getByRole("button", { name: "Move…" }));
  await screen.findByText("Move this environment?");
  expect(screen.getByText("/disk/app-feature")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move" }));

  await waitFor(() => expect(move).toHaveBeenCalledWith("env-1", "/disk"));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  const update = (onUpdate.mock.calls as unknown as Array<[Environment]>)[0]![0];
  expect(update.worktreePath).toBe("/disk/app-feature");
  // Explicitly cleared so a field-by-field store merge cannot keep "moving".
  expect("lifecycleOperation" in update).toBe(true);
  expect(update.lifecycleOperation).toBeUndefined();
  expect(update.lifecycleError).toBeNull();
});

test("shows the backend's refusal", async () => {
  spyOn(backend, "moveEnvironment").mockRejectedValue(new Error("An agent is running"));
  render(<EnvironmentMoveSection environment={environment()} onUpdate={() => undefined} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Destination folder" }), {
    target: { value: "/elsewhere" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Move…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  await screen.findByText("An agent is running");
  expect(mockToastError).toHaveBeenCalled();
});

test("is unavailable while an agent is running in the environment", () => {
  const move = spyOn(backend, "moveEnvironment");
  render(
    <EnvironmentMoveSection
      environment={environment({ agentActivityState: "working" })}
      onUpdate={() => undefined}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Destination folder" }), {
    target: { value: "/elsewhere" },
  });
  expect(screen.getByRole("button", { name: "Move…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toContain("An agent is running");
  expect(move).not.toHaveBeenCalled();
});

test("explains every blocked state", () => {
  expect(environmentMoveBlockedReason(environment())).toBeNull();
  expect(environmentMoveBlockedReason(environment({ agentActivityState: "waiting" }))).toContain(
    "agent",
  );
  expect(environmentMoveBlockedReason(environment({ lifecycleOperation: "moving" }))).toContain(
    "being moved",
  );
  expect(environmentMoveBlockedReason(environment({ lifecycleOperation: "deleting" }))).toContain(
    "deleted",
  );
  expect(environmentMoveBlockedReason(environment({ status: "creating" }))).toContain("starting");
});

test("rehydrates moving controls and partial-success warnings after an inactive update", async () => {
  const onUpdate = mock(() => undefined);
  const rendered = render(
    <EnvironmentMoveSection environment={environment()} onUpdate={onUpdate} />,
  );
  rendered.rerender(
    <EnvironmentMoveSection
      environment={environment({ lifecycleOperation: "moving" })}
      onUpdate={onUpdate}
    />,
  );
  expect(screen.getByRole("button", { name: "Move…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toContain("being moved");
  cleanup();
  render(
    <EnvironmentMoveSection
      environment={environment({
        worktreePath: "/disk/app-feature",
        worktreeMove: {
          from: "/trees/app-feature",
          to: "/disk/app-feature",
          phase: "committed",
          startedAt: new Date().toISOString(),
        },
        lifecycleError: "Environment moved, but Codex conversations could not be relocated.",
      })}
      onUpdate={onUpdate}
    />,
  );
  expect(
    (screen.getByRole("textbox", { name: "Destination folder" }) as HTMLInputElement).value,
  ).toBe("/disk");
  expect(screen.getByRole("alert").textContent).toContain("Codex");
  expect(screen.getByRole("button", { name: "Move…" })).toHaveProperty("disabled", true);
});

test("a partial backend move updates the usable path and shows a warning", async () => {
  const moved = environment({
    worktreePath: "/disk/app-feature",
    worktreeMove: {
      from: "/trees/app-feature",
      to: "/disk/app-feature",
      phase: "committed",
      startedAt: new Date().toISOString(),
    },
    lifecycleError: "Environment moved, but Claude conversations could not be relocated.",
  });
  spyOn(backend, "moveEnvironment").mockResolvedValue(moved);
  const onUpdate = mock(() => undefined);
  render(<EnvironmentMoveSection environment={environment()} onUpdate={onUpdate} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Destination folder" }), {
    target: { value: "/disk" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Move…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move" }));
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: moved.worktreePath,
        lifecycleError: moved.lifecycleError,
      }),
    ),
  );
  expect(mockToastWarning).toHaveBeenCalledWith("Environment moved with a warning", {
    description: moved.lifecycleError,
  });
});

for (const phase of ["moving", "copied"] as const) {
  test(`retained ${phase} journal disables moving and explains restart recovery`, () => {
    const pending = environment({
      worktreeMove: {
        from: "/trees/app-feature",
        to: "/disk/app-feature",
        phase,
        startedAt: "now",
      },
    });
    render(<EnvironmentMoveSection environment={pending} onUpdate={() => undefined} />);
    expect(screen.getByRole("button", { name: "Move…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toContain("Restart Orkestrator");
  });
}
