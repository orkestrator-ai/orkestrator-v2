import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
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
  test("every messaging switch is named and toggles from its visible label", async () => {
    renderMessagingLayout();
    await screen.findByRole("switch", { name: "Enable messaging" });
    for (const name of [
      "Enable messaging",
      "Pause delivery",
      "Allow cross-project messages",
      "Wake peers",
    ]) {
      const control = screen.getByRole("switch", { name });
      const label = screen.getByText(name, { selector: "label" });
      expect(label.getAttribute("for")).toBe(control.id);
      expect(screen.getByLabelText(name) === control).toBe(true);
      const before = control.getAttribute("aria-checked");
      fireEvent.click(label);
      expect(control.getAttribute("aria-checked")).toBe(before === "true" ? "false" : "true");
    }
  });

  test("offers coordinator status updates, defaulting to decisions and problems", async () => {
    renderMessagingLayout();
    const select = (await screen.findByLabelText(
      "Coordinator status updates",
    )) as HTMLSelectElement;
    expect(select.value).toBe("settled");
    expect(Array.from(select.options, (option) => option.value)).toEqual([
      "off",
      "settled",
      "stages",
    ]);

    jest.useFakeTimers();
    try {
      act(() => {
        fireEvent.change(select, { target: { value: "stages" } });
      });
      await act(async () => {
        jest.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateAgentMessagingSettings).toHaveBeenCalledWith({
        ...DEFAULT_AGENT_MESSAGING_SETTINGS,
        coordinatorStatusWakes: "stages",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("offers no save or reset controls", async () => {
    renderMessagingLayout();

    await screen.findAllByRole("switch");
    expect(screen.queryByRole("button", { name: "Reset" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: /save/i }) === null).toBe(true);
  });

  test("auto-saves an edit after a change", async () => {
    renderMessagingLayout();

    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[0]!);

    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1));
    expect(updateAgentMessagingSettings).toHaveBeenCalledWith({
      ...DEFAULT_AGENT_MESSAGING_SETTINGS,
      enabled: false,
    });
  });

  test("does not retry a rejected value until it changes again", async () => {
    updateAgentMessagingSettings.mockRejectedValueOnce(new Error("nope"));
    renderMessagingLayout();

    const retention = (await screen.findByLabelText("Retention days")) as HTMLInputElement;
    fireEvent.change(retention, { target: { value: "30" } });

    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1);

    fireEvent.change(retention, { target: { value: "31" } });
    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(2));
  });
});
