import { describe, expect, test } from "bun:test";
import type { RepositoryConfig } from "@/types";
import { editableRepositorySettings, repositorySettingsPatch } from "./repository-settings-patch";

const base: RepositoryConfig = { defaultBranch: "main", prBaseBranch: "main" };

describe("repositorySettingsPatch: the coordinator's other environments", () => {
  test("turning it on sends only that field", () => {
    expect(repositorySettingsPatch({ ...base, coordinatorOtherEnvironments: true }, base)).toEqual({
      updates: { coordinatorOtherEnvironments: true },
      unset: [],
    });
  });

  test("turning it off removes the field, so off stays the absent default", () => {
    expect(repositorySettingsPatch(base, { ...base, coordinatorOtherEnvironments: true })).toEqual({
      updates: {},
      unset: ["coordinatorOtherEnvironments"],
    });
  });

  test("saving other settings never writes it", () => {
    const patch = repositorySettingsPatch({ ...base, defaultBranch: "next" }, base);
    expect(patch.updates).toEqual({ defaultBranch: "next" });
    expect(patch.unset).toEqual([]);
    expect(editableRepositorySettings(base).coordinatorOtherEnvironments).toBeUndefined();
  });
});
