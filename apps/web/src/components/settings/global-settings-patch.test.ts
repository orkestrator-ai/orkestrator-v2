import { describe, expect, test } from "bun:test";
import { shippedReviewLensPresets } from "@orkestrator/protocol/review-lens";
import { DEFAULT_REVIEW_INSTRUCTION } from "@/prompts";
import { useConfigStore } from "@/stores/configStore";
import { storedCoreFields } from "./GlobalSettings";
import { globalConfigPatchFromCoreFields, isEmptyGlobalConfigPatch } from "./global-settings-patch";
import { repositorySettingsPatch } from "./repository-settings-patch";

const baseline = storedCoreFields(useConfigStore.getState().config.global);

describe("globalConfigPatchFromCoreFields", () => {
  test("an unchanged form produces an empty patch", () => {
    expect(isEmptyGlobalConfigPatch(globalConfigPatchFromCoreFields(baseline, baseline))).toBe(
      true,
    );
  });

  test("sends only the changed fields", () => {
    const changes = globalConfigPatchFromCoreFields(
      { ...baseline, terminalScrollback: 1234, allowedDomains: ["a.test"] },
      baseline,
    );
    expect(changes).toEqual({
      patch: { terminalScrollback: 1234, allowedDomains: ["a.test"] },
      unset: [],
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
