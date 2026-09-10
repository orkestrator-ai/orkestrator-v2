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
      <span data-testid={`${props.id} provider-labels`}>
        {props.models
          .map((model) => model.providerLabel)
          .filter(Boolean)
          .join(",")}
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
      <span data-testid={`${props.id} speed-available`}>{String(props.fastModeAvailable)}</span>
      <span data-testid={`${props.id} speed-inherit`}>{String(props.speedInherit?.selected)}</span>
      <span data-testid={`${props.id} speed-inherit-label`}>{props.speedInherit?.label}</span>
      <button
        type="button"
        aria-label={`${props.id} choose Fast`}
        disabled={!props.fastModeAvailable}
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
  codex: [
    {
      id: "codex-a",
      name: "Codex A",
      reasoningEfforts: ["medium", "high"],
      supportsSpeed: true,
    },
  ],
  cursor: [{ id: "cursor-a", name: "Cursor A", reasoningEfforts: ["medium"] }],
  opencode: [
    {
      id: "opencode-go/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      providerLabel: "opencode-go",
      description: "opencode-go",
      reasoningEfforts: ["low", "high"],
    },
  ],
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

  test("shows and persists the review preparation and consolidation default separately", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness scope="global" onChange={onChange} />);

    expect(
      screen.getByRole("combobox", {
        name: "Review preparation & consolidation default agent, model and reasoning",
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "action-default-reviewPreparation choose Codex A" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "action-default-reviewPreparation choose high reasoning",
      }),
    );

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionDefaults: expect.objectContaining({
          reviewPreparation: {
            platform: "codex",
            model: "codex-a",
            reasoningEffort: "high",
          },
        }),
      }),
    );
  });
});

describe("AgentDefaultsPane speed defaults", () => {
  test("keeps OpenCode provider captions in every Defaults picker", () => {
    render(<SettingsHarness scope="global" onChange={() => {}} />);

    expect(screen.getByTestId("agent-default-model provider-labels").textContent).toContain(
      "opencode-go",
    );
    expect(screen.getByTestId("action-default-review2 provider-labels").textContent).toContain(
      "opencode-go",
    );
  });

  test("checks an inherited action model even when its platform differs from the tier default", () => {
    const repository: AgentSettingsTier = { defaultAgent: "codex" };
    render(
      <AgentDefaultsPane
        tier={repository}
        onChange={() => {}}
        tiers={{
          global: {
            actionDefaults: {
              createScript: { platform: "claude", model: "claude-slow" },
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

    expect(screen.getByTestId("action-default-createScript speed-available").textContent).toBe(
      "false",
    );
  });

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

  test("writes Fast onto that action default only", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness scope="global" onChange={onChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: "action-default-createScript choose Codex A" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "action-default-createScript choose Fast" }),
    );

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionDefaults: {
          createScript: { platform: "codex", model: "codex-a", fastMode: true },
        },
      }),
    );
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.codex?.fastMode).toBeUndefined();

    fireEvent.click(
      screen.getByRole("button", { name: "action-default-createScript inherit speed" }),
    );
    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults?.createScript).toEqual({
      platform: "codex",
      model: "codex-a",
    });
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.codex?.fastMode).toBeUndefined();
  });

  test("keeps Fast independent across action defaults that share a model", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<SettingsHarness scope="global" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "action-default-pr choose Codex A" }));
    fireEvent.click(screen.getByRole("button", { name: "action-default-pr choose Fast" }));
    fireEvent.click(
      screen.getByRole("button", { name: "action-default-reviewPreparation choose Codex A" }),
    );

    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults).toEqual({
      pr: { platform: "codex", model: "codex-a", fastMode: true },
      reviewPreparation: { platform: "codex", model: "codex-a" },
    });
    expect(screen.getByTestId("action-default-pr speed-value").textContent).toBe("true");
    expect(screen.getByTestId("action-default-pr speed-inherit").textContent).toBe("false");
    expect(screen.getByTestId("action-default-reviewPreparation speed-value").textContent).toBe(
      "null",
    );
    expect(screen.getByTestId("action-default-reviewPreparation speed-inherit").textContent).toBe(
      "true",
    );
  });

  test("keeps an inherited model and reasoning level when a child tier pins Fast", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    const global: AgentSettingsTier = {
      defaultAgent: "claude",
      actionDefaults: {
        pr: { platform: "codex", model: "codex-a", reasoningEffort: "high" },
      },
    };

    function Harness() {
      const [repository, setRepository] = useState<AgentSettingsTier>({});
      return (
        <AgentDefaultsPane
          tier={repository}
          onChange={(next) => {
            setRepository(next);
            onChange(next);
          }}
          tiers={{ global, repository }}
          canInherit
          enabledPlatforms={["claude", "codex", "opencode"]}
          catalog={catalog}
          scopeLabel="this repository"
        />
      );
    }

    render(<Harness />);
    // A narrower tier's entry replaces the parent's whole, so a speed-only
    // toggle has to carry the inherited model and reasoning level with it.
    fireEvent.click(screen.getByRole("button", { name: "action-default-pr choose Fast" }));

    expect(onChange.mock.calls.at(-1)?.[0].actionDefaults?.pr).toEqual({
      platform: "codex",
      model: "codex-a",
      reasoningEffort: "high",
      fastMode: true,
    });
  });

  test("ignores an inherited Fast whose platform is no longer enabled", () => {
    const global: AgentSettingsTier = {
      defaultAgent: "claude",
      actionDefaults: {
        pr: { platform: "cursor", model: "cursor-a", fastMode: true },
      },
    };
    const repository: AgentSettingsTier = {};
    render(
      <AgentDefaultsPane
        tier={repository}
        onChange={() => {}}
        tiers={{ global, repository }}
        canInherit
        enabledPlatforms={["claude", "codex", "opencode"]}
        catalog={catalog}
        scopeLabel="this repository"
      />,
    );

    // The runtime resolver drops that entry whole, so the row must fall back to
    // the effective agent's own speed rather than showing Cursor's Fast.
    expect(screen.getByTestId("action-default-pr speed-value").textContent).toBe("null");
    expect(screen.getByTestId("action-default-pr speed-inherit").textContent).toBe("true");
  });

  test("uses the platform default model to determine Fast availability for inherited actions", () => {
    const global: AgentSettingsTier = {
      defaultAgent: "claude",
      platforms: { claude: { model: "claude-slow" } },
    };
    render(
      <AgentDefaultsPane
        tier={global}
        onChange={() => {}}
        tiers={{ global }}
        canInherit={false}
        enabledPlatforms={["claude", "codex", "opencode"]}
        catalog={catalog}
        scopeLabel="the app"
      />,
    );

    expect(screen.getByTestId("agent-default-model speed-available").textContent).toBe("false");
    expect(screen.getByTestId("action-default-createScript speed-available").textContent).toBe(
      "false",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "action-default-createScript choose Fast",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("resolves a platform-only action through that platform's default model", () => {
    const catalogWithSlowCodex: AgentModelCatalog = {
      ...catalog,
      codex: [...catalog.codex, { id: "codex-slow", name: "Codex Slow", reasoningEfforts: [] }],
    };
    const global: AgentSettingsTier = {
      defaultAgent: "claude",
      platforms: { codex: { model: "codex-slow" } },
      actionDefaults: { createScript: { platform: "codex" } },
    };
    render(
      <AgentDefaultsPane
        tier={global}
        onChange={() => {}}
        tiers={{ global }}
        canInherit={false}
        enabledPlatforms={["claude", "codex", "opencode"]}
        catalog={catalogWithSlowCodex}
        scopeLabel="the app"
      />,
    );

    expect(screen.getByTestId("action-default-createScript speed-available").textContent).toBe(
      "false",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "action-default-createScript choose Fast",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("uses the displayed platform's default when a stored action platform is disabled", () => {
    const repository: AgentSettingsTier = {
      defaultAgent: "claude",
      actionDefaults: { createScript: { platform: "cursor", model: "cursor-a" } },
    };
    render(
      <AgentDefaultsPane
        tier={repository}
        onChange={() => {}}
        tiers={{
          global: { platforms: { claude: { model: "claude-a" } } },
          repository,
        }}
        canInherit
        enabledPlatforms={["claude", "codex", "opencode"]}
        catalog={catalog}
        scopeLabel="this repository"
      />,
    );

    expect(screen.getByTestId("action-default-createScript speed-available").textContent).toBe(
      "true",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "action-default-createScript choose Fast",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
