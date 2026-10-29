import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import * as backend from "@/lib/backend";
import { onGlobalSettingsRequest, type GlobalSettingsSection } from "@/lib/settings-navigation";
import { useBugReportStore } from "@/stores/bugReportStore";
import { SidebarBottomBar } from "./SidebarBottomBar";

const originalGateway = window.orkestratorGateway;
const originalOrkestrator = window.orkestrator;

function hostUpdate(updateAvailable: boolean | null) {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      updater: {
        ...hostMaintenanceSnapshotFixture().updater,
        latestVersion: updateAvailable ? "9.0.0" : null,
        updateAvailable,
      },
    }),
  );
}

/** Let the host maintenance snapshot the bar reads arrive. */
async function renderBar() {
  const view = render(<SidebarBottomBar />);
  await waitFor(() => expect(backend.getHostMaintenance).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

beforeEach(() => {
  window.orkestrator = undefined;
  window.orkestratorGateway = undefined;
});

afterEach(() => {
  cleanup();
  mock.restore();
  useBugReportStore.setState({ sheetOpen: false, draftInProgress: false });
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
});

describe("SidebarBottomBar", () => {
  test("puts global settings on the left and the bug report on the right", async () => {
    hostUpdate(false);
    const sections: GlobalSettingsSection[] = [];
    const stop = onGlobalSettingsRequest((section) => sections.push(section));
    try {
      const { container } = await renderBar();
      const bar = container.querySelector("[data-sidebar-bottom-bar]")!;
      const buttons = Array.from(bar.querySelectorAll("button"));
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        "Global settings",
        "Report a bug",
      ]);
      const settings = screen.getByRole("button", { name: "Global settings" });
      expect(settings.getAttribute("title")).toBe("Global settings");
      expect(screen.getByRole("button", { name: "Report a bug" }).getAttribute("title")).toBe(
        "Report a bug",
      );

      fireEvent.click(settings);
      expect(sections).toEqual(["general"]);
      expect(screen.queryByTestId("settings-update-dot") === null).toBe(true);
    } finally {
      stop();
    }
  });

  test("opens the bug report sheet and marks a draft in progress", async () => {
    hostUpdate(null);
    await renderBar();
    const bug = screen.getByRole("button", { name: "Report a bug" });
    expect(screen.queryByTestId("bug-report-draft-dot") === null).toBe(true);
    expect(bug.getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(bug);
    expect(useBugReportStore.getState().sheetOpen).toBe(true);

    act(() => useBugReportStore.getState().setDraftInProgress(true));
    expect(screen.getByTestId("bug-report-draft-dot")).toBeTruthy();
    const description = bug.getAttribute("aria-describedby");
    expect(description && document.getElementById(description)?.textContent).toBe(
      "Draft in progress",
    );
  });

  test("marks an available update on Settings, which still open on their first section", async () => {
    hostUpdate(true);
    const sections: GlobalSettingsSection[] = [];
    const stop = onGlobalSettingsRequest((section) => sections.push(section));
    try {
      await renderBar();
      expect(await screen.findByTestId("settings-update-dot")).toBeTruthy();
      const settings = screen.getByRole("button", { name: "Global settings" });
      expect(settings.getAttribute("title")).toBe("Global settings · Update available");
      const description = settings.getAttribute("aria-describedby");
      expect(description && document.getElementById(description)?.textContent).toBe(
        "Update available",
      );

      fireEvent.click(settings);
      expect(sections).toEqual(["general"]);
    } finally {
      stop();
    }
  });
});
