import { describe, expect, test } from "bun:test";
import {
  environmentBranchNamespace,
  isBranchInEnvironmentNamespace,
  isEnvironmentBranchName,
  isEnvironmentOwnedBranch,
  parseEnvironmentBranchNamespace,
} from "./environment-branch";

const ENVIRONMENT_ID = "ce98b4c6-2352-4a1b-9c3d-0123456789ab";
const OTHER_ENVIRONMENT_ID = "aa1f36a5-c1e0-490d-b6a9-44d676b3985c";

describe("environment branch ownership", () => {
  test("the namespace is the first twelve id characters", () => {
    expect(environmentBranchNamespace(ENVIRONMENT_ID)).toBe("ce98b4c62352");
  });

  test("the environment owns its branch through every rename revision and collision suffix", () => {
    for (const branch of [
      "20261109-140520-ce98b4c62352",
      "fix-login-ce98b4c62352-r2",
      "fix-login-ce98b4c62352-1",
      "fix-login-ce98b4c62352-r3-2-1",
    ]) {
      expect(isEnvironmentOwnedBranch(ENVIRONMENT_ID, branch)).toBe(true);
      expect(isEnvironmentBranchName(branch)).toBe(true);
    }
  });

  test("base branches and branches made by hand are never owned", () => {
    for (const branch of ["dev", "main", "master", "release/2026-11", "feature/usage", "", null]) {
      expect(isEnvironmentOwnedBranch(ENVIRONMENT_ID, branch)).toBe(false);
      expect(isEnvironmentBranchName(branch)).toBe(false);
    }
  });

  test("another environment's branch is not this environment's", () => {
    const other = `investigate-${environmentBranchNamespace(OTHER_ENVIRONMENT_ID)}-r1`;
    expect(isEnvironmentOwnedBranch(OTHER_ENVIRONMENT_ID, other)).toBe(true);
    expect(isEnvironmentOwnedBranch(ENVIRONMENT_ID, other)).toBe(false);
  });

  test("the namespace must end the slug, not merely appear in it", () => {
    expect(isEnvironmentOwnedBranch(ENVIRONMENT_ID, "ce98b4c62352-hotfix")).toBe(false);
    expect(isEnvironmentOwnedBranch(ENVIRONMENT_ID, "x-ce98b4c62352/dev")).toBe(false);
    expect(parseEnvironmentBranchNamespace("x-ce98b4c62352-r0")).toBeNull();
  });

  test("an id that cannot form a twelve-character namespace owns nothing", () => {
    expect(isEnvironmentOwnedBranch("e1", "feature-e1")).toBe(false);
    expect(isBranchInEnvironmentNamespace("orphanedbran", "x-orphanedbran")).toBe(false);
    expect(isBranchInEnvironmentNamespace("", "dev")).toBe(false);
  });
});
