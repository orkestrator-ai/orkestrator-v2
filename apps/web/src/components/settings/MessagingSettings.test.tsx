import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessagesSquare, Settings2 } from "lucide-react";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  type AgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import * as realBackend from "@/lib/backend";

const getAgentMessagingSettings = mock(async (): Promise<AgentMessagingSettings> => ({
  ...DEFAULT_AGENT_MESSAGING_SETTINGS,
}));
const updateAgentMessagingSettings = mock(async (_settings: AgentMessagingSettings) => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getAgentMessagingSettings,
  updateAgentMessagingSettings,
}));

const { FullscreenSettingsLayout } = await import("./FullscreenSettingsLayout");
const { MessagingSettings } = await import("./MessagingSettings");

const menuItems = [
  { id: "messaging", label: "Messaging", icon: <MessagesSquare /> },
  { id: "general", label: "General", icon: <Settings2 /> },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderMessagingLayout() {
  return render(
    <FullscreenSettingsLayout
      open
      onOpenChange={() => undefined}
      title="Settings"
      menuItems={menuItems}
    >
      {(section) => (section === "messaging" ? <MessagingSettings /> : <div>General content</div>)}
    </FullscreenSettingsLayout>,
  );
}

beforeEach(() => {
  getAgentMessagingSettings.mockReset();
  getAgentMessagingSettings.mockResolvedValue({ ...DEFAULT_AGENT_MESSAGING_SETTINGS });
  updateAgentMessagingSettings.mockReset();
  updateAgentMessagingSettings.mockResolvedValue(undefined);
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("MessagingSettings", () => {
  test("shows header actions only after settings load and removes them on section change", async () => {
    const pendingSettings = deferred<AgentMessagingSettings>();
    getAgentMessagingSettings.mockImplementationOnce(() => pendingSettings.promise);
    renderMessagingLayout();

    expect(screen.queryByRole("button", { name: "Reset" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" }) === null).toBe(true);

    await act(async () => {
      pendingSettings.resolve({ ...DEFAULT_AGENT_MESSAGING_SETTINGS });
      await pendingSettings.promise;
    });

    const reset = await screen.findByRole("button", { name: "Reset" });
    const save = screen.getByRole("button", { name: "Save changes" });
    const headerActions = reset.closest('[data-slot="settings-header-actions"]');
    expect(headerActions?.contains(save)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /General/ }));
    expect(screen.getByText("General content")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" }) === null).toBe(true);
  });

  test("enables actions for edits and resets to the saved value", async () => {
    renderMessagingLayout();

    const switches = await screen.findAllByRole("switch");
    const reset = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(save.disabled).toBe(true);

    fireEvent.click(switches[0]!);
    expect(reset.disabled).toBe(false);
    expect(save.disabled).toBe(false);

    fireEvent.click(reset);
    expect((switches[0] as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(reset.disabled).toBe(true);
    expect(save.disabled).toBe(true);
  });

  test("saves edited settings and disables the actions again", async () => {
    renderMessagingLayout();

    const retention = (await screen.findByLabelText("Retention days")) as HTMLInputElement;
    fireEvent.change(retention, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1));
    expect(updateAgentMessagingSettings).toHaveBeenCalledWith({
      ...DEFAULT_AGENT_MESSAGING_SETTINGS,
      retentionDays: 30,
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });
});
