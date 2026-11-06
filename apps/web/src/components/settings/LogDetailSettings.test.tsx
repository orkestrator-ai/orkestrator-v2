import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { LogDetail } from "@orkestrator/protocol/log-policy";
import { LogDetailSettings } from "./LogDetailSettings";
import { LOG_DETAIL_PRESETS, matchingLogDetailPreset } from "./log-detail-presets";

afterEach(cleanup);

const normal: LogDetail = { level: "info", areaLevels: {} };
const bridgeDebug: LogDetail = { level: "info", areaLevels: { bridge: "debug" } };

function presetTrigger() {
  return screen.getByRole("combobox", { name: "Log detail preset" });
}

describe("Log Detail presets", () => {
  test("every preset is an ordinary setting, and matches itself", () => {
    for (const preset of LOG_DETAIL_PRESETS) {
      expect(Object.keys(preset.detail).sort()).toEqual(["areaLevels", "level"]);
      expect(matchingLogDetailPreset(preset.detail)?.id).toBe(preset.id);
    }
  });

  test("shows the preset the current levels match, and Custom otherwise", () => {
    const { rerender } = render(<LogDetailSettings value={bridgeDebug} onChange={() => {}} />);
    expect(presetTrigger().textContent).toContain("Agent sessions");
    rerender(
      <LogDetailSettings
        value={{ level: "info", areaLevels: { git: "trace" } }}
        onChange={() => {}}
      />,
    );
    expect(presetTrigger().textContent).toContain("Custom");
    expect(screen.getByTestId("log-detail-preset-description").textContent).toContain("by hand");
  });

  test("choosing a preset writes plain level and areaLevels", async () => {
    const onChange = mock((_next: LogDetail) => {});
    render(<LogDetailSettings value={normal} onChange={onChange} />);
    fireEvent.click(presetTrigger());
    fireEvent.click(await screen.findByRole("option", { name: "Crashes and stopped processes" }));
    expect(onChange).toHaveBeenCalledWith({
      level: "info",
      areaLevels: { backend: "debug", desktop: "debug", "local-server": "debug" },
    });
  });

  test("an edit by hand after a preset shows Custom", async () => {
    function Harness() {
      const [value, setValue] = useState<LogDetail>(normal);
      return <LogDetailSettings value={value} onChange={setValue} />;
    }
    render(<Harness />);
    fireEvent.click(presetTrigger());
    fireEvent.click(await screen.findByRole("option", { name: "Everything" }));
    expect(presetTrigger().textContent).toContain("Everything");
    fireEvent.click(screen.getByRole("combobox", { name: "Default log level" }));
    fireEvent.click(await screen.findByRole("option", { name: "Trace" }));
    expect(presetTrigger().textContent).toContain("Custom");
  });
});

describe("Log Detail privacy and expiry", () => {
  test("states what logs are designed to leave out, without promising never", () => {
    render(<LogDetailSettings value={normal} onChange={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Logs are designed to leave out prompts, terminal output, file contents and credentials.",
    );
    expect(text).not.toMatch(/\bnever\b/i);
  });

  test("detail at info says nothing about expiry", () => {
    render(<LogDetailSettings value={normal} onChange={() => {}} />);
    expect(screen.queryByTestId("log-detail-expiry") === null).toBe(true);
  });

  test("saved raised detail shows when it goes back, and leaves saving alone", () => {
    render(
      <LogDetailSettings
        value={bridgeDebug}
        onChange={() => {}}
        expiresAt="2026-11-06T12:00:00.000Z"
        onKeepRaisedChange={() => {}}
      />,
    );
    const notice = screen.getByTestId("log-detail-expiry").textContent ?? "";
    expect(notice).toContain("goes back to Info at");
    expect(notice).toContain("Saving logs to disk is not changed");
  });

  test("an unsaved raise promises 24 hours from saving, not the old expiry", () => {
    render(
      <LogDetailSettings
        value={bridgeDebug}
        stored={normal}
        onChange={() => {}}
        expiresAt="2026-11-06T12:00:00.000Z"
      />,
    );
    expect(screen.getByTestId("log-detail-expiry").textContent).toContain("24 hours after");
  });

  test("first unsaved raise waits for backend confirmation", () => {
    render(
      <LogDetailSettings
        value={bridgeDebug}
        stored={normal}
        onChange={() => {}}
        expirySupported={false}
      />,
    );
    const notice = screen.getByTestId("log-detail-expiry").textContent ?? "";
    expect(notice).toContain("Save raised detail to confirm");
    expect(notice).not.toContain("stays on");
    expect(notice).not.toContain("24 hours");
  });

  test("keeping it raised is a switch, and says it stays on", () => {
    const onKeepRaisedChange = mock((_keep: boolean) => {});
    const { rerender } = render(
      <LogDetailSettings
        value={bridgeDebug}
        onChange={() => {}}
        expirySupported
        onKeepRaisedChange={onKeepRaisedChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Keep raised log detail on" }));
    expect(onKeepRaisedChange).toHaveBeenCalledWith(true);
    rerender(
      <LogDetailSettings
        value={bridgeDebug}
        onChange={() => {}}
        keepRaised
        expirySupported
        onKeepRaisedChange={onKeepRaisedChange}
      />,
    );
    expect(screen.getByTestId("log-detail-expiry").textContent).toContain("stays on");
  });
});

test("a backend without expiry metadata makes no automatic reversion promise", () => {
  render(
    <LogDetailSettings value={bridgeDebug} onChange={() => {}} onKeepRaisedChange={() => {}} />,
  );
  expect(screen.getByTestId("log-detail-expiry").textContent).toContain("not confirmed");
  expect(screen.getByTestId("log-detail-expiry").textContent).not.toContain("24 hours");
  expect(screen.queryByRole("switch", { name: "Keep raised log detail on" }) === null).toBe(true);
});
