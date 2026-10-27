import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { DataSavingSetting } from "./DataSavingSetting";

afterEach(() => {
  cleanup();
  useUIStore.setState({ dataSaving: false });
});

test("the switch reflects and changes this client's data-saving preference", () => {
  useUIStore.setState({ dataSaving: false });
  render(<DataSavingSetting />);
  const toggle = screen.getByRole("switch", { name: "Data saving" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(useUIStore.getState().dataSaving).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
