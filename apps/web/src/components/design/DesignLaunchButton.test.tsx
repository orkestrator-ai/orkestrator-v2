import { afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { DesignCapabilities } from "@orkestrator/protocol/design-operations";
import { invoke } from "@/lib/native/backend";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { resetCapabilities } from "@/lib/design-client";
import { DesignLaunchButton } from "./DesignLaunchButton";
import { appCommandStore } from "@/test/app-command-store";

// `@/lib/native/backend` is mocked once in tests/setup.ts; vary its behavior here.
const invokeMock = invoke as unknown as Mock<(command: string, args?: unknown) => Promise<unknown>>;

const capabilities: DesignCapabilities = {
  protocolVersion: 2,
  responseVersion: 2,
  snapshot: true,
  operations: true,
  sync: true,
  save: true,
  history: true,
  lifecycle: true,
  rendererHealth: true,
  library: true,
  batch: true,
  sessions: true,
  validation: true,
  hierarchyPaging: true,
};

beforeEach(() => {
  resetCapabilities();
  invokeMock.mockClear();
  // A backend whose renderer has no Chromium.
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "design_capabilities") return { ok: true, value: capabilities };
    if (command === "design_readiness")
      return {
        ok: true,
        value: {
          capabilities,
          storage: { available: true, canvases: 0, limit: 256 },
          renderer: {
            state: "missing-executable",
            ready: false,
            message:
              "Design workspaces require Chromium. Install Chromium or set ORKESTRATOR_DESIGN_CHROMIUM_PATH to its executable.",
            queued: 0,
            running: 0,
            generation: 0,
            executableConfigured: false,
          },
        },
      };
    throw new Error(`Unexpected command: ${command}`);
  });
  appCommandStore(paneLayoutStore).setState((state) => ({
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
    renderInAppCommandScope(
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
    expect(dialog.className).toContain("max-w-(--modal-limit)");
    expect(dialog.className).toContain("[--modal-max-width:42rem]");
    expect(dialog.className).toContain(
      "sm:[--modal-limit:min(var(--modal-max-width),calc(100%-2rem))]",
    );
    await flush();
  });

  test("stays enabled without a renderer or free tabs and probes only when opened", async () => {
    renderInAppCommandScope(
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
      "design_readiness",
    ]);
    expect(screen.getByText(/Creating a design needs the renderer/)).toBeTruthy();
  });

  test("is disabled only without an environment", () => {
    renderInAppCommandScope(<DesignLaunchButton disabled={false} tabCount={0} createTab={null} />);
    expect(
      (screen.getByRole("button", { name: "New design workspace" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
