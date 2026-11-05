import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyRendererLogLevel, DEBUG_LOG_STORAGE_KEY } from "@/lib/debug-log";
import { RendererDebugSettings } from "./RendererDebugSettings";

afterEach(() => {
  cleanup();
  localStorage.removeItem(DEBUG_LOG_STORAGE_KEY);
  applyRendererLogLevel();
});

test("turning it on sets orkestrator:debug for this window and reloads", () => {
  applyRendererLogLevel();
  const reload = mock(() => undefined);
  render(<RendererDebugSettings reload={reload} desktop />);
  const toggle = screen.getByRole("switch", { name: "Renderer debug logging for this window" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(/Help → Open Developer Tools/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(localStorage.getItem(DEBUG_LOG_STORAGE_KEY)).toBe("1");
  expect(reload).toHaveBeenCalledTimes(1);
});

test("on shows the state in force, and turning it off clears the key and reloads", () => {
  localStorage.setItem(DEBUG_LOG_STORAGE_KEY, "1");
  applyRendererLogLevel();
  const reload = mock(() => undefined);
  render(<RendererDebugSettings reload={reload} desktop={false} />);
  const toggle = screen.getByRole("switch", { name: "Renderer debug logging for this window" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("On in this window")).toBeTruthy();
  expect(screen.queryByText(/Help → Open Developer Tools/)).toBeNull();
  fireEvent.click(toggle);
  expect(localStorage.getItem(DEBUG_LOG_STORAGE_KEY)).toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
});
