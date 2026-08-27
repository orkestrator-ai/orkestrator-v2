import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import * as realAgentModelPicker from "@/components/chat/AgentModelPicker";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import type { AgentSettingsTier, AgentSettingsTiers } from "@orkestrator/protocol/agent-settings";

const realAgentModelPickerSnapshot = { ...realAgentModelPicker };

mock.module("@/components/chat/AgentModelPicker", () => ({
  AgentModelPicker: (props: React.ComponentProps<typeof realAgentModelPicker.AgentModelPicker>) => (
    <div data-testid={`picker-${props.id}`}>
      <button type="button" role="combobox" aria-label={props.ariaLabel}>
        {props.selectedModelLabel}
      </button>
      <button
        type="button"
        aria-label={`${props.id} choose Codex A`}
        onClick={() =>
          props.onModelSelect?.({ platform: "codex", id: "codex-a", label: "Codex A" })
        }
      >
        Choose Codex A
      </button>
      <button
        type="button"
        aria-label={`${props.id} choose high reasoning`}
        onClick={() => props.onReasoningChange?.("high")}
      >
        Choose high reasoning
      </button>
    </div>
  ),
}));

const { AgentDefaultsPane } = await import("./AgentDefaultsPane");

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/chat/AgentModelPicker", () => realAgentModelPickerSnapshot);
});

const catalog: AgentModelCatalog = {
  claude: [{ id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] }],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] }],
  opencode: [],
};

type Scope = "global" | "repository" | "environment";

function SettingsHarness({
  scope,
  onChange,
}: {
  scope: Scope;
  onChange: (tier: AgentSettingsTier) => void;
}) {
  const [tier, setTier] = useState<AgentSettingsTier>({ defaultAgent: "claude" });
  const tiers: AgentSettingsTiers =
    scope === "global"
      ? { global: tier }
      : scope === "repository"
        ? { global: { defaultAgent: "claude" }, repository: tier }
        : {
            global: { defaultAgent: "claude" },
            repository: {},
            environment: tier,
          };

  return (
    <AgentDefaultsPane
      tier={tier}
      onChange={(next) => {
        setTier(next);
        onChange(next);
      }}
      tiers={tiers}
      canInherit={scope !== "global"}
      enabledPlatforms={["claude", "codex", "opencode"]}
      catalog={catalog}
      scopeLabel={scope === "global" ? "by default" : `in this ${scope}`}
    />
  );
}

describe("AgentDefaultsPane create-script defaults", () => {
  test("renders and persists provider, model, and reasoning changes at every settings tier", () => {
    for (const scope of ["global", "repository", "environment"] as const) {
      const onChange = mock((_tier: AgentSettingsTier) => undefined);
      const view = render(<SettingsHarness scope={scope} onChange={onChange} />);

      expect(
        screen.getByRole("combobox", {
          name: "Create run script default agent, model and reasoning",
        }),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "action-default-createScript choose Codex A" }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "action-default-createScript choose high reasoning",
        }),
      );

      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          actionDefaults: {
            createScript: {
              platform: "codex",
              model: "codex-a",
              reasoningEffort: "high",
            },
          },
        }),
      );
      view.unmount();
    }
  });
});
