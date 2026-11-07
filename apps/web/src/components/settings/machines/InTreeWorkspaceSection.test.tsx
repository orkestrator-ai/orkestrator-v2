import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { InTreeWorkspaceSection, USE_REALMS_LABEL } from "./InTreeWorkspaceSection";

afterEach(() => {
  cleanup();
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
});

test("the rollback switch is off by default and says it is temporary", () => {
  render(<InTreeWorkspaceSection />);
  const toggle = screen.getByRole("switch", { name: USE_REALMS_LABEL });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("Other machines' workspaces open directly in this window.")).toBeTruthy();
  expect(screen.getByText(/Temporary: it goes away in a later release\./)).toBeTruthy();
});

test("turning the switch on brings realms back for this window, and off again", () => {
  render(<InTreeWorkspaceSection />);
  const toggle = screen.getByRole("switch", { name: USE_REALMS_LABEL });
  fireEvent.click(toggle);
  expect(useInTreeNodesStore.getState().useRealmsForRemoteMachines).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/open in separate workspace views/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(useInTreeNodesStore.getState().useRealmsForRemoteMachines).toBe(false);
});
