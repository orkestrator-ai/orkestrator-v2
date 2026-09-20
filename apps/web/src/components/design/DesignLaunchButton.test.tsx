import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

const invokeMock = mock((command: string) => {
  if (command === "design_status") return Promise.resolve({ ready: true });
  if (command === "design_action") return Promise.resolve([]);
  return Promise.reject(new Error(`Unexpected command: ${command}`));
});

mock.module("@/lib/native/backend", () => ({ invoke: invokeMock }));

const { DesignLaunchButton } = await import("./DesignLaunchButton");

afterEach(cleanup);

describe("DesignLaunchButton", () => {
  test("keeps sm viewport gutters while capping the launch dialog at 42rem", async () => {
    usePaneLayoutStore.setState((state) => ({
      hydration: new Map(state.hydration).set("env-1", "done"),
    }));

    await act(async () => {
      render(
        <DesignLaunchButton
          environmentId="env-1"
          disabled={false}
          tabCount={0}
          createTab={() => true}
        />,
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New design workspace" }));
    });

    const dialog = screen.getByRole("dialog", { name: "Design workspace" });
    expect(dialog.className).toContain("max-w-[calc(100%-1rem)]");
    expect(dialog.className).toContain("sm:max-w-[min(42rem,calc(100%-2rem))]");
    expect(dialog.className).not.toContain("sm:max-w-2xl");
  });
});
