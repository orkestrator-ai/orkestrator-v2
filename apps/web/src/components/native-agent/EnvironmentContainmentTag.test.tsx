import { describe, expect, test } from "bun:test";
import { describeEnvironmentContainment } from "./EnvironmentContainmentTag";

describe("describeEnvironmentContainment", () => {
  test("a local worktree runs on the host network whatever its stored mode", () => {
    const containment = describeEnvironmentContainment({
      environmentType: "local",
      networkAccessMode: "restricted",
      branch: "feature/x",
    });
    expect(containment).toMatchObject({
      isolation: "worktree",
      network: "host network",
      branch: "feature/x",
      container: false,
    });
    expect(containment.explanation).toContain("no container firewall");
  });

  test("a container names its network mode", () => {
    expect(
      describeEnvironmentContainment({
        environmentType: "containerized",
        networkAccessMode: "restricted",
        branch: "b",
      }).network,
    ).toBe("restricted network");
    expect(
      describeEnvironmentContainment({
        environmentType: "containerized",
        networkAccessMode: "full",
        branch: "b",
      }).network,
    ).toBe("full network");
  });

  test("the project home is the checkout itself", () => {
    expect(
      describeEnvironmentContainment({
        environmentType: "local",
        networkAccessMode: "full",
        branch: "main",
        projectHome: true,
      }).isolation,
    ).toBe("project checkout");
  });
});
