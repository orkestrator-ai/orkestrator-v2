import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { DebugButtonSetting } from "./DebugButtonSetting";

afterEach(() => {
  cleanup();
  useUIChromeStore.setState({ debugButtonEnabled: false });
});

test("the switch is off by default and turns the debug button on for this window", () => {
  render(<DebugButtonSetting />);
  const toggle = screen.getByRole("switch", { name: "Debug button" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(useUIChromeStore.getState().debugButtonEnabled).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(useUIChromeStore.getState().debugButtonEnabled).toBe(false);
});
