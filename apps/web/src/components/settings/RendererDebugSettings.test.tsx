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
  expect(screen.queryByText(/Help → Open Developer Tools/) === null).toBe(true);
  fireEvent.click(toggle);
  expect(localStorage.getItem(DEBUG_LOG_STORAGE_KEY)).toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
});

test("a refused storage lookup leaves the switch usable and does not reload", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const reload = mock(() => undefined);
  render(<RendererDebugSettings reload={reload} desktop={false} />);
  const toggle = screen.getByRole("switch", { name: "Renderer debug logging for this window" });
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    fireEvent.click(toggle);
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(reload).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  fireEvent.click(toggle);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("in the iOS app it names Safari's Web Inspector", () => {
  applyRendererLogLevel();
  render(<RendererDebugSettings reload={() => undefined} desktop={false} iosApp />);
  expect(screen.getByText(/Safari's Web Inspector on a Mac/)).toBeTruthy();
  expect(screen.queryByText(/Your browser's developer tools/) === null).toBe(true);
});
