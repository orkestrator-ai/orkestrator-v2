import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import * as realAgentModelPicker from "@/components/chat/AgentModelPicker";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import type { AgentSettingsTier, AgentSettingsTiers } from "@orkestrator/protocol/agent-settings";

const realAgentModelPickerSnapshot = { ...realAgentModelPicker };

mock.module("@/components/chat/AgentModelPicker", () => ({
  AgentModelPicker: (props: React.ComponentProps<typeof realAgentModelPicker.AgentModelPicker>) => (
    <div data-testid={`picker-${props.id}`}>
      <button type="button" role="combobox" aria-label={props.ariaLabel}>
        {props.selectedPlatform ? (
          <span data-native-model-platform={props.selectedPlatform} aria-hidden="true">
            <AgentPlatformIcon platform={props.selectedPlatform} />
          </span>
        ) : null}
        {props.selectedModelLabel}
      </button>
      <span data-testid={`${props.id} selected-platform-model-count`}>
        {props.models.filter((model) => model.platform === props.selectedPlatform).length}
      </span>
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
        aria-label={`${props.id} choose Claude Slow`}
        onClick={() =>
          props.onModelSelect?.({ platform: "claude", id: "claude-slow", label: "Claude Slow" })
        }
      >
        Choose Claude Slow
      </button>
      <button
        type="button"
        aria-label={`${props.id} choose high reasoning`}
        onClick={() => props.onReasoningChange?.("high")}
      >
        Choose high reasoning
      </button>
      <span data-testid={`${props.id} speed-value`}>{String(props.fastModeEnabled)}</span>
      <span data-testid={`${props.id} speed-inherit`}>{String(props.speedInherit?.selected)}</span>
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
    </div>
  ),
}));

const { AgentDefaultsPane } = await import("./AgentDefaultsPane");

afterEach(cleanup);
afterAll(() => {
  mock.module("@/components/chat/AgentModelPicker", () => realAgentModelPickerSnapshot);
});

const catalog: AgentModelCatalog = {
  claude: [
    {
      id: "claude-a",
      name: "Claude A",
      reasoningEfforts: ["low", "high"],
      supportsSpeed: true,
    },
    { id: "claude-slow", name: "Claude Slow", reasoningEfforts: [] },
  ],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] }],
  cursor: [{ id: "cursor-a", name: "Cursor A", reasoningEfforts: ["medium"] }],
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
  test.each([
    ["claude", "Claude"],
    ["cursor", "Cursor Agent"],
  ] as const)(
    "shows the %s icon for action defaults inherited from %s",
    (inheritedPlatform, _label) => {
      const repository: AgentSettingsTier = { defaultAgent: "codex" };
      render(
        <AgentDefaultsPane
          tier={repository}
          onChange={() => {}}
          tiers={{
            global: {
              defaultAgent: "codex",
              actionDefaults: {
                createScript: { platform: inheritedPlatform, model: `${inheritedPlatform}-a` },
              },
            },
            repository,
          }}
          canInherit
          enabledPlatforms={["claude", "codex", "cursor", "opencode"]}
          catalog={catalog}
          scopeLabel="this repository"
        />,
      );

      const picker = screen.getByRole("combobox", {
        name: "Create run script default agent, model and reasoning",
      });
      expect(picker.textContent).toContain(`Inherit — ${_label}`);
      expect(
        picker.querySelector(`[data-native-model-platform='${inheritedPlatform}']`),
      ).toBeTruthy();
      expect(picker.querySelector("[data-native-model-platform='codex']") === null).toBe(true);
    },
  );

  test("falls back to the effective agent when the inherited provider is disabled", () => {
    const repository: AgentSettingsTier = { defaultAgent: "codex" };
    render(
      <AgentDefaultsPane
        tier={repository}
        onChange={() => {}}
        tiers={{
          global: {
            defaultAgent: "codex",
            actionDefaults: {
              createScript: { platform: "cursor", model: "cursor-a" },
            },
          },
          repository,
        }}
        canInherit
        enabledPlatforms={["claude", "codex", "opencode"]}
        catalog={catalog}
        scopeLabel="this repository"
      />,
    );

    const picker = screen.getByRole("combobox", {
      name: "Create run script default agent, model and reasoning",
    });
    expect(picker.textContent).toBe("Inherit");
    expect(picker.querySelector("[data-native-model-platform='codex']")).toBeTruthy();
    expect(picker.querySelector("[data-native-model-platform='cursor']") === null).toBe(true);
    expect(
      screen.getByTestId("action-default-createScript selected-platform-model-count").textContent,
    ).toBe("1");
  });

  test("uses the effective agent when there is no inherited action entry", () => {
    const repository: AgentSettingsTier = { defaultAgent: "codex" };
    render(
      <AgentDefaultsPane
        tier={repository}
        onChange={() => {}}
        tiers={{ global: { defaultAgent: "claude" }, repository }}
        canInherit
        enabledPlatforms={["claude", "codex", "opencode"]}
        catalog={catalog}
        scopeLabel="this repository"
      />,
    );

    const picker = screen.getByRole("combobox", {
      name: "Create run script default agent, model and reasoning",
    });
    expect(picker.textContent).toBe("Inherit");
    expect(picker.querySelector("[data-native-model-platform='codex']")).toBeTruthy();
    expect(
      screen.getByTestId("action-default-createScript selected-platform-model-count").textContent,
    ).toBe("1");
  });

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

describe("AgentDefaultsPane speed defaults", () => {
  test("writes Fast and clears it back to provider default", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness scope="global" onChange={onChange} />);

    expect(screen.getByTestId("agent-default-model speed-value").textContent).toBe("null");
    expect(screen.getByTestId("agent-default-model speed-inherit").textContent).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "agent-default-model choose Fast" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        platforms: expect.objectContaining({ claude: expect.objectContaining({ fastMode: true }) }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "agent-default-model inherit speed" }));
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.claude?.fastMode).toBeUndefined();
  });

  test("clears Fast when the selected model does not support speed", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness scope="global" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "agent-default-model choose Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "agent-default-model choose Claude Slow" }));

    expect(onChange.mock.calls.at(-1)?.[0].platforms?.claude).toMatchObject({
      model: "claude-slow",
    });
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.claude?.fastMode).toBeUndefined();
  });
});
