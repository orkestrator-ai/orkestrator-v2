import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import * as realAgentModelPicker from "@/components/chat/AgentModelPicker";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";

const realAgentModelPickerSnapshot = { ...realAgentModelPicker };

mock.module("@/components/chat/AgentModelPicker", () => ({
  AgentModelPicker: (props: React.ComponentProps<typeof realAgentModelPicker.AgentModelPicker>) => (
    <div data-testid={`picker-${props.id}`}>
      <span data-testid={`${props.id} platform`}>{props.selectedPlatform}</span>
      <span data-testid={`${props.id} speed-value`}>{String(props.fastModeEnabled)}</span>
      <span data-testid={`${props.id} speed-available`}>{String(props.fastModeAvailable)}</span>
      <span data-testid={`${props.id} speed-inherit-selected`}>
        {String(props.speedInherit?.selected)}
      </span>
      <span data-testid={`${props.id} speed-inherit-label`}>{props.speedInherit?.label}</span>
      <button
        type="button"
        aria-label={`${props.id} choose Normal`}
        onClick={() => props.onFastModeChange?.(false)}
      >
        Choose Normal
      </button>
      <button
        type="button"
        aria-label={`${props.id} choose Fast`}
        onClick={() => props.onFastModeChange?.(true)}
      >
        Choose Fast
      </button>
      <button
        type="button"
        aria-label={`${props.id} inherit speed`}
        onClick={() => props.onFastModeInherit?.()}
      >
        Inherit speed
      </button>
      <button
        type="button"
        aria-label={`${props.id} choose Codex`}
        onClick={() => props.onPlatformChange?.("codex")}
      >
        Choose Codex
      </button>
    </div>
  ),
}));

const { MultiReviewDefaultsEditor } = await import("./MultiReviewDefaultsEditor");

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/chat/AgentModelPicker", () => realAgentModelPickerSnapshot);
});

const catalog: AgentModelCatalog = {
  claude: [
    {
      id: "claude-fast",
      name: "Claude Fast",
      reasoningEfforts: [],
      supportsSpeed: true,
    },
  ],
  codex: [{ id: "codex-fast", name: "Codex Fast", reasoningEfforts: [], supportsSpeed: true }],
  opencode: [],
};

function SettingsHarness({
  canInherit,
  onChange,
}: {
  canInherit: boolean;
  onChange: (tier: AgentSettingsTier) => void;
}) {
  const [tier, setTier] = useState<AgentSettingsTier>({});
  const global: AgentSettingsTier = {
    defaultAgent: "claude",
    platforms: {
      claude: { model: "claude-fast", fastMode: true },
      codex: { model: "codex-fast", fastMode: false },
    },
  };

  return (
    <MultiReviewDefaultsEditor
      tier={tier}
      onChange={(next) => {
        setTier(next);
        onChange(next);
      }}
      tiers={canInherit ? { global, repository: tier } : { global: tier }}
      canInherit={canInherit}
      enabledPlatforms={["claude", "codex"]}
      catalog={catalog}
    />
  );
}

describe("MultiReviewDefaultsEditor Fast defaults", () => {
  test("labels and clears a repository override as inheritance while retaining parent Fast", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness canInherit onChange={onChange} />);

    expect(screen.getByTestId("multi-review-default-0 speed-inherit-label").textContent).toBe(
      "Inherit",
    );
    expect(screen.getByTestId("multi-review-default-0 speed-inherit-selected").textContent).toBe(
      "true",
    );
    expect(screen.getByTestId("multi-review-default-0 speed-value").textContent).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "multi-review-default-0 choose Normal" }));
    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults?.review).toEqual({
      platform: "claude",
      fastMode: false,
    });
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.claude?.fastMode).toBeUndefined();
    expect(screen.getByTestId("multi-review-default-0 speed-value").textContent).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "multi-review-default-0 inherit speed" }));
    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults?.review).toEqual({ platform: "claude" });
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.claude?.fastMode).toBeUndefined();
    expect(screen.getByTestId("multi-review-default-0 speed-value").textContent).toBe("true");
  });

  test("writes Fast onto the selected reviewer only", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness canInherit onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "multi-review-default-0 choose Codex" }));
    expect(screen.getByTestId("multi-review-default-0 platform").textContent).toBe("codex");
    expect(screen.getByTestId("multi-review-default-0 speed-value").textContent).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "multi-review-default-0 choose Fast" }));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
      actionDefaults: { review: { platform: "codex", fastMode: true } },
    });
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.codex?.fastMode).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "multi-review-default-1 choose Normal" }));
    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults).toEqual({
      review: { platform: "codex", fastMode: true },
      review2: { platform: "codex", fastMode: false },
    });
    expect(screen.getByTestId("multi-review-default-0 speed-value").textContent).toBe("true");
    expect(screen.getByTestId("multi-review-default-1 speed-value").textContent).toBe("false");
  });

  test("keeps the model a reviewer was following when it pins Fast", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);

    function Harness() {
      const [tier, setTier] = useState<AgentSettingsTier>({
        defaultAgent: "claude",
        actionDefaults: {
          review: { platform: "claude", model: "claude-fast", reasoningEffort: "high" },
        },
      });
      return (
        <MultiReviewDefaultsEditor
          tier={tier}
          onChange={(next) => {
            setTier(next);
            onChange(next);
          }}
          tiers={{ global: tier }}
          canInherit={false}
          enabledPlatforms={["claude", "codex"]}
          catalog={catalog}
        />
      );
    }

    render(<Harness />);
    // Reviewer 2 follows Review until it stores something of its own. Writing a
    // speed there must not drop the model and reasoning level it was showing.
    fireEvent.click(screen.getByRole("button", { name: "multi-review-default-1 choose Fast" }));

    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults?.review2).toEqual({
      platform: "claude",
      model: "claude-fast",
      reasoningEffort: "high",
      fastMode: true,
    });
    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults?.review).toEqual({
      platform: "claude",
      model: "claude-fast",
      reasoningEffort: "high",
    });
  });

  test("labels the root-tier reset as the provider default", () => {
    render(<SettingsHarness canInherit={false} onChange={() => {}} />);

    expect(screen.getByTestId("multi-review-default-0 speed-inherit-label").textContent).toBe(
      "Provider default",
    );
  });
});
