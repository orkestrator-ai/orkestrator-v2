import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessagesSquare, Settings2 } from "lucide-react";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  type AgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import * as realBackend from "@/lib/backend";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { mockToastError as toastError } from "../../../../../tests/mocks/sonner";

const getAgentMessagingSettings = mock(async (): Promise<AgentMessagingSettings> => ({
  ...DEFAULT_AGENT_MESSAGING_SETTINGS,
}));
// The backend answers with the normalised settings it stored, never the config.
const updateAgentMessagingSettings = mock(
  async (settings: AgentMessagingSettings): Promise<AgentMessagingSettings> => settings,
);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getAgentMessagingSettings,
  updateAgentMessagingSettings,
}));

const { FullscreenSettingsLayout } = await import("./FullscreenSettingsLayout");
const { MESSAGING_AUTO_SAVE_DEBOUNCE_MS, MessagingSettings } = await import("./MessagingSettings");

let autoSaveClock: ReturnType<typeof installControlledTimeout> | undefined;

/** Captures the auto-save debounce so a test fires it instead of sleeping past it. */
function controlAutoSave() {
  autoSaveClock = installControlledTimeout(MESSAGING_AUTO_SAVE_DEBOUNCE_MS, {
    label: "messaging auto-save debounce",
  });
  return autoSaveClock;
}

async function fireAutoSave() {
  const clock = autoSaveClock!;
  await waitFor(() => expect(clock.pendingCount()).toBe(1));
  await act(async () => {
    clock.advance();
    await Promise.resolve();
  });
}

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
  updateAgentMessagingSettings.mockImplementation(async (settings) => settings);
});

afterEach(() => {
  cleanup();
  autoSaveClock?.restore();
  autoSaveClock = undefined;
});

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
    controlAutoSave();
    renderMessagingLayout();

    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[0]!);

    await fireAutoSave();
    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1));
    expect(updateAgentMessagingSettings).toHaveBeenCalledWith({
      ...DEFAULT_AGENT_MESSAGING_SETTINGS,
      enabled: false,
    });
  });

  test("does not retry a rejected value until it changes again", async () => {
    updateAgentMessagingSettings.mockRejectedValueOnce(new Error("nope"));
    toastError.mockClear();
    const clock = controlAutoSave();
    renderMessagingLayout();

    const retention = (await screen.findByLabelText("Retention days")) as HTMLInputElement;
    fireEvent.change(retention, { target: { value: "30" } });

    await fireAutoSave();
    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1));
    // Once the rejection has settled, no further save is armed for that value.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(clock.pendingCount()).toBe(0);
    expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(1);

    fireEvent.change(retention, { target: { value: "31" } });
    await fireAutoSave();
    await waitFor(() => expect(updateAgentMessagingSettings).toHaveBeenCalledTimes(2));
  });
});
