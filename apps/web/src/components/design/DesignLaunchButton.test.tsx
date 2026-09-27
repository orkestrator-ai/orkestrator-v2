import { afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { resetCapabilities } from "./design-client";
import { DesignLaunchButton } from "./DesignLaunchButton";

// `@/lib/native/backend` is mocked once in tests/setup.ts; vary its behavior here.
const invokeMock = invoke as unknown as Mock<(command: string, args?: unknown) => Promise<unknown>>;

beforeEach(() => {
  resetCapabilities();
  invokeMock.mockClear();
  // An old backend whose renderer has no Chromium.
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "design_capabilities")
      throw new Error("Unknown backend command: design_capabilities");
    if (command === "design_status")
      return {
        ready: false,
        error:
          "Design workspaces require Chromium. Install Chromium or set ORKESTRATOR_DESIGN_CHROMIUM_PATH to its executable.",
      };
    if (command === "design_action") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
  usePaneLayoutStore.setState((state) => ({
    hydration: new Map(state.hydration).set("env-1", "done"),
  }));
});

afterEach(() => {
  cleanup();
  resetCapabilities();
  invokeMock.mockImplementation(() => Promise.resolve());
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("DesignLaunchButton", () => {
  test("keeps sm viewport gutters while capping the launch dialog at 42rem", async () => {
    render(
      <DesignLaunchButton
        environmentId="env-1"
        disabled={false}
        tabCount={0}
        createTab={() => true}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New design workspace" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Design workspace" });
    expect(dialog.className).toContain("max-w-[calc(100%-1rem)]");
    expect(dialog.className).toContain("sm:max-w-[min(42rem,calc(100%-2rem))]");
    expect(dialog.className).not.toContain("sm:max-w-2xl");
    await flush();
  });

  test("stays enabled without a renderer or free tabs and probes only when opened", async () => {
    render(
      <DesignLaunchButton environmentId="env-1" disabled tabCount={99} createTab={() => true} />,
    );
    await flush();
    const button = screen.getByRole("button", {
      name: "New design workspace",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.click(button);
    await flush();
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "design_capabilities",
      "design_status",
    ]);
    expect(screen.getByText(/Renderer unavailable: Chromium is not installed/)).toBeTruthy();
  });

  test("is disabled only without an environment", () => {
    render(<DesignLaunchButton disabled={false} tabCount={0} createTab={null} />);
    expect(
      (screen.getByRole("button", { name: "New design workspace" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
