import { describe, expect, test } from "bun:test";
import { shippedReviewLensPresets } from "@orkestrator/protocol/review-lens";
import { DEFAULT_REVIEW_INSTRUCTION } from "@/prompts";
import { configStore } from "@/stores/configStore";
import { storedCoreFields } from "./GlobalSettings";
import { globalConfigPatchFromCoreFields } from "./global-settings-patch";
import { repositorySettingsPatch } from "./repository-settings-patch";
import { appCommandStore } from "@/test/app-command-store";

const baseline = storedCoreFields(appCommandStore(configStore).getState().config.global);

describe("globalConfigPatchFromCoreFields", () => {
  test("an unchanged form produces an empty patch", () => {
    expect(globalConfigPatchFromCoreFields(baseline, baseline)).toEqual({ patch: {}, unset: [] });
  });

  test("defaults unset raw stored keys even when the normalized baseline equals the form", () => {
    const stored = {
      ...appCommandStore(configStore).getState().config.global,
      claudeBackgroundCommandLimitHours: 24,
    };
    const changes = globalConfigPatchFromCoreFields(baseline, baseline, stored);
    expect(changes.patch).toEqual({});
    expect(changes.unset).toContain("claudeBackgroundCommandLimitHours");
  });

  test("a retired key left in the stored config is neither sent nor unset", () => {
    const stored = {
      ...appCommandStore(configStore).getState().config.global,
      experimentalCodexRawEventLogging: true,
    };
    expect(storedCoreFields(stored)).not.toHaveProperty("experimentalCodexRawEventLogging");
    const changes = globalConfigPatchFromCoreFields(
      { ...baseline, terminalScrollback: 1234 },
      baseline,
      stored,
    );
    expect(changes.patch).toEqual({ terminalScrollback: 1234 });
    expect(changes.unset).not.toContain("experimentalCodexRawEventLogging" as never);
  });

  test("stores a preview-tab link default and unsets the external one", () => {
    expect(
      globalConfigPatchFromCoreFields(
        { ...baseline, terminalLinkDefaultTarget: "browser-tab" },
        baseline,
      ),
    ).toEqual({ patch: { terminalLinkDefaultTarget: "browser-tab" }, unset: [] });
    expect(
      globalConfigPatchFromCoreFields(baseline, {
        ...baseline,
        terminalLinkDefaultTarget: "browser-tab",
      }).unset,
    ).toContain("terminalLinkDefaultTarget");
  });

  test("sends only the changed fields", () => {
    const changes = globalConfigPatchFromCoreFields(
      {
        ...baseline,
        terminalScrollback: 1234,
        allowedDomains: ["a.test"],
        autoMergeRequireChecks: false,
      },
      baseline,
    );
    expect(changes).toEqual({
      patch: {
        terminalScrollback: 1234,
        allowedDomains: ["a.test"],
        autoMergeRequireChecks: false,
      },
      unset: [],
    });
  });

  test("auto-steer is stored when turned on and removed when turned back off", () => {
    expect(baseline.autoSteer).toBe(false);
    const on = { ...baseline, autoSteer: true };
    expect(globalConfigPatchFromCoreFields(on, baseline)).toEqual({
      patch: { autoSteer: true },
      unset: [],
    });
    expect(globalConfigPatchFromCoreFields(baseline, on)).toEqual({
      patch: {},
      unset: ["autoSteer"],
    });
  });

  test("a field returned to its default is removed rather than stored", () => {
    const edited = {
      ...baseline,
      reviewInstruction: "Be strict",
      sshAgentSocketPath: "/tmp/agent.sock",
    };
    expect(globalConfigPatchFromCoreFields(edited, baseline).patch).toEqual({
      reviewInstruction: "Be strict",
      sshAgentSocketPath: "/tmp/agent.sock",
    });
    const reverted = {
      ...edited,
      reviewInstruction: DEFAULT_REVIEW_INSTRUCTION,
      sshAgentSocketPath: "",
      reviewLensPresets: shippedReviewLensPresets(),
    };
    const changes = globalConfigPatchFromCoreFields(reverted, edited);
    expect(changes.patch).toEqual({});
    expect(changes.unset.sort()).toEqual(["reviewInstruction", "sshAgentSocketPath"]);
  });
});

describe("repositorySettingsPatch", () => {
  const stored = {
    defaultBranch: "main",
    prBaseBranch: "main",
    filesToCopy: [".env"],
    lastEnvironmentType: "local" as const,
  };

  test("reports only edited fields and never backend-owned state", () => {
    expect(
      repositorySettingsPatch({ ...stored, defaultBranch: "trunk" } as never, stored as never),
    ).toEqual({ updates: { defaultBranch: "trunk" }, unset: [] });
  });

  test("a cleared optional field is unset; empty and absent lists are the same", () => {
    expect(repositorySettingsPatch({ ...stored, filesToCopy: [] }, stored)).toEqual({
      updates: {},
      unset: ["filesToCopy"],
    });
    expect(
      repositorySettingsPatch({ ...stored, defaultPortMappings: [] }, stored as never),
    ).toEqual({ updates: {}, unset: [] });
  });
});
