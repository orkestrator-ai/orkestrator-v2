import { afterEach, describe, expect, test } from "bun:test";
import { act, screen } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import {
  EnvironmentContainmentTag,
  describeEnvironmentContainment,
} from "./EnvironmentContainmentTag";

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

  test("a container names only its configured network mode", () => {
    expect(
      describeEnvironmentContainment({
        environmentType: "containerized",
        networkAccessMode: "restricted",
        branch: "b",
      }).network,
    ).toBe("configured restricted network");
    expect(
      describeEnvironmentContainment({
        environmentType: "containerized",
        networkAccessMode: "full",
        branch: "b",
      }).network,
    ).toBe("configured full network");
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

describe("EnvironmentContainmentTag", () => {
  afterEach(cleanupNodeScopes);

  test.each([
    { configured: "restricted", applied: { effective: { mode: "full" } } },
    { configured: "full", applied: { effective: { mode: "restricted" } } },
    { configured: "restricted", applied: null },
    { configured: "restricted", applied: new Error("policy unavailable") },
  ] as const)(
    "saved $configured policy stays explicitly configured regardless of applied status",
    ({ configured, applied }) => {
      const client = new FakeNodeClient({
        invoke: {
          get_environment_network_policy: () => {
            if (applied instanceof Error) throw applied;
            return applied;
          },
        },
      });
      const { scope } = renderInNodeScope(<EnvironmentContainmentTag environmentId="target" />, {
        client,
      });
      act(() =>
        scope.store(environmentStore).setState({
          environments: [
            {
              id: "target",
              environmentType: "containerized",
              networkAccessMode: configured,
              branch: "feature/pending",
            } as Environment,
          ],
        }),
      );
      const tag = screen.getByTestId("environment-containment");
      expect(tag.title).toContain(`configured ${configured} network`);
      expect(tag.title).toContain("Check Network policy for its applied status");
      expect(client.invocations).toEqual([]);
    },
  );

  test("looks up the requested environment, renders its title, and follows saved changes before rebuild", () => {
    const { scope, client } = renderInNodeScope(
      <EnvironmentContainmentTag environmentId="target" className="containment-test" />,
    );
    expect(screen.queryByTestId("environment-containment") === null).toBe(true);
    const saved = {
      id: "target",
      environmentType: "containerized",
      networkAccessMode: "restricted",
      branch: "feature/saved",
    } as Environment;
    act(() =>
      scope
        .store(environmentStore)
        .setState({ environments: [{ ...saved, id: "other", branch: "wrong-branch" }, saved] }),
    );
    const tag = screen.getByTestId("environment-containment");
    expect(tag.textContent).toContain("configured restricted network");
    expect(tag.textContent).not.toContain("wrong-branch");
    expect(tag.title).toContain("container · configured restricted network · feature/saved");
    expect(tag.title).toContain("running container may use an earlier policy until rebuilt");
    expect(tag.classList.contains("containment-test")).toBe(true);
    // No applied-policy read is made: absent, failed, or disagreeing applied
    // policy cannot turn this saved configuration into an enforcement claim.
    expect("invocations" in client && client.invocations).toEqual([]);
    act(() =>
      scope
        .store(environmentStore)
        .setState({ environments: [{ ...saved, networkAccessMode: "full" }] }),
    );
    expect(tag.title).toContain("configured full network");
    expect(tag.title).toContain("may use an earlier policy until rebuilt");
    act(() => scope.store(environmentStore).setState({ environments: [] }));
    expect(screen.queryByTestId("environment-containment") === null).toBe(true);
  });
});
