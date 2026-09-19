import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import * as notificationSounds from "@/lib/notification-sounds";
import { useConfigStore } from "@/stores/configStore";
import { SoundsSettings } from "./SoundsSettings";

const originalConfig = structuredClone(useConfigStore.getState().config);

beforeEach(() => {
  useConfigStore.setState({ config: structuredClone(originalConfig) });
});

afterEach(() => {
  cleanup();
  useConfigStore.setState({ config: structuredClone(originalConfig) });
});

describe("SoundsSettings", () => {
  test("persists each event independently", async () => {
    const update = spyOn(backend, "updateGlobalConfig").mockImplementation(async (global) => ({
      ...useConfigStore.getState().config,
      global,
    }));

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent stopped sound" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0].notificationSounds).toEqual({
      agentStopped: false,
      prMerged: true,
    });
    expect(
      screen.getByRole("switch", { name: "Pull request merged sound" }).getAttribute("data-state"),
    ).toBe("checked");
    update.mockRestore();
  });

  test("previews the two distinct cues even when their toggles are off", async () => {
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: { agentStopped: false, prMerged: false },
    });
    const play = spyOn(notificationSounds, "playNotificationSound").mockResolvedValue(true);

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Agent stopped" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Pull request merged" }));

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(play.mock.calls.map(([kind]) => kind)).toEqual(["agent-stopped", "pr-merged"]);
    play.mockRestore();
  });
});
