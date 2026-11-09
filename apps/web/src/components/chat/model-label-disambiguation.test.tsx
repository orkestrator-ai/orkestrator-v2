import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { AgentModelPicker } from "./AgentModelPicker";
import { disambiguatingProviderLabel } from "./model-label-disambiguation";

afterEach(cleanup);

const zen: AgentModel = {
  platform: "opencode",
  id: "opencode/beam-free",
  label: "Beam Free",
  providerLabel: "opencode",
};
const go: AgentModel = {
  platform: "opencode",
  id: "opencode-go/beam-free",
  label: "beam-free",
  providerLabel: "opencode-go",
};
const other: AgentModel = {
  platform: "opencode",
  id: "opencode/other",
  label: "Other",
  providerLabel: "opencode",
};

describe("disambiguatingProviderLabel", () => {
  test("names the provider when another provider lists a look-alike model", () => {
    expect(disambiguatingProviderLabel(zen, [zen, go, other])).toBe("opencode");
    expect(disambiguatingProviderLabel(go, [zen, go, other])).toBe("opencode-go");
  });

  test("leaves an unambiguous name alone", () => {
    expect(disambiguatingProviderLabel(other, [zen, go, other])).toBeUndefined();
    expect(disambiguatingProviderLabel(zen, [zen, other])).toBeUndefined();
  });

  test("ignores look-alikes on another platform, and models with no provider", () => {
    const codex: AgentModel = { ...go, platform: "codex", providerLabel: "OpenAI" };
    expect(disambiguatingProviderLabel(zen, [zen, codex])).toBeUndefined();
    const { providerLabel: _omitted, ...bare } = zen;
    expect(disambiguatingProviderLabel(bare, [bare, go])).toBeUndefined();
    expect(disambiguatingProviderLabel(undefined, [zen, go])).toBeUndefined();
  });
});

function renderPicker(selected: AgentModel, models: AgentModel[]) {
  return render(
    <AgentModelPicker
      models={models}
      selectedPlatform="opencode"
      selectedModelId={selected.id}
      selectedModelLabel={selected.label}
      onModelChange={mock(() => {})}
      reasoningOptions={[{ id: "default", label: "Default" }]}
      selectedReasoningId="default"
      selectedReasoningLabel="Default"
      speedCapable={false}
    />,
  );
}

describe("AgentModelPicker trigger", () => {
  test("names the selected model's provider when a look-alike is listed", () => {
    renderPicker(zen, [zen, go, other]);
    expect(screen.getByTestId("model-picker-trigger-provider").textContent).toContain("opencode");
    expect(screen.getByRole("button", { name: "Beam Free (Default) · opencode" })).toBeTruthy();
  });

  test("shows the bare name when nothing else looks like it", () => {
    renderPicker(other, [zen, go, other]);
    expect(screen.queryByTestId("model-picker-trigger-provider") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Other (Default)" })).toBeTruthy();
  });
});
