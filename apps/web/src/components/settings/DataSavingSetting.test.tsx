import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { DataSavingSetting } from "./DataSavingSetting";

afterEach(() => {
  cleanup();
  useUIChromeStore.setState({ dataSaving: false });
});

test("the switch reflects and changes this client's data-saving preference", () => {
  useUIChromeStore.setState({ dataSaving: false });
  render(<DataSavingSetting />);
  const toggle = screen.getByRole("switch", { name: "Data saving" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(useUIChromeStore.getState().dataSaving).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
