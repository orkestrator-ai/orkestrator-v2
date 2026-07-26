import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Environment } from "@/types";
import { EnvironmentItem } from "./EnvironmentItem";

const environment: Environment = {
  id: "environment-1",
  projectId: "project-1",
  name: "mobile-preview-ui",
  branch: "mobile-preview-ui",
  containerId: "container-1",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: false,
  createdAt: "2026-07-26T20:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
};

afterEach(cleanup);

describe("EnvironmentItem", () => {
  test("opens the shared environment actions from a mobile-only row button", async () => {
    const onSelect = mock(() => undefined);
    const onStop = mock(() => undefined);

    render(
      <EnvironmentItem
        environment={environment}
        isSelected={false}
        onSelect={onSelect}
        onDelete={mock(() => undefined)}
        onStart={mock(() => undefined)}
        onStop={onStop}
        onRestart={mock(() => undefined)}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open actions for mobile-preview-ui",
    });
    expect(trigger.classList.contains("md:hidden")).toBe(true);

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "touch",
    });
    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Restart" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith("environment-1");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
