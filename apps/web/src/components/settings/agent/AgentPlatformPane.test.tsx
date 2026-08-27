import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentPlatformPane } from "./AgentPlatformPane";

afterEach(cleanup);

const catalog = { claude: [], codex: [], opencode: [] };

describe("AgentPlatformPane model refresh", () => {
  test("offers an environment-free refresh action", () => {
    const onRefreshModels = mock(() => undefined);
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
        onRefreshModels={onRefreshModels}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh OpenCode models" }));

    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/without starting an environment/i)).toBeTruthy();
  });

  test("disables the action while a catalogue refresh is running", () => {
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
        onRefreshModels={() => undefined}
        refreshingModels
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh OpenCode models" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("keeps the environment guidance when no refresh action is available", () => {
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
      />,
    );

    expect(screen.queryByRole("button", { name: "Refresh OpenCode models" }) === null).toBe(true);
    expect(
      screen.getByText(/start an environment to load available opencode models/i),
    ).toBeTruthy();
  });
});
