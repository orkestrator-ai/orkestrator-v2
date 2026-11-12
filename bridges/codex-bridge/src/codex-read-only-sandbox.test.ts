import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import {
  CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER,
  codexReadOnlyCommandSandboxOff,
} from "./codex-read-only-sandbox.js";

const policy = (
  sandbox: NativeAgentExecutionPolicy["sandbox"],
  id: NativeAgentExecutionPolicy["id"] = "interactive-host",
): NativeAgentExecutionPolicy => ({
  id,
  sandbox,
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
});

describe("codexReadOnlyCommandSandboxOff", () => {
  test("a Linux bridge in a container with no session policy runs read-only turns without the sandbox", () => {
    expect(codexReadOnlyCommandSandboxOff({ platform: "linux", inContainer: () => true })).toBe(
      CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER,
    );
  });

  test("a container session counts even where no container marker is visible", () => {
    expect(
      codexReadOnlyCommandSandboxOff({
        policy: policy("container", "interactive-container"),
        platform: "linux",
        inContainer: () => false,
      }),
    ).toBe(CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER);
  });

  test("an interactive container session counts even under a provider-sandbox override", () => {
    expect(
      codexReadOnlyCommandSandboxOff({
        policy: policy("provider", "interactive-container"),
        platform: "linux",
        inContainer: () => false,
      }),
    ).toBe(CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER);
  });

  test("a container marker counts whatever sandbox the session policy names", () => {
    // A containerised environment can resolve to a `provider` or `none`
    // sandbox (full network, an override, the `pipeline` id); bubblewrap is
    // still refused inside the container.
    for (const sessionPolicy of [
      policy("none"),
      policy("provider"),
      policy("none", "pipeline"),
      policy("provider", "pipeline"),
    ]) {
      expect(
        codexReadOnlyCommandSandboxOff({
          policy: sessionPolicy,
          platform: "linux",
          inContainer: () => true,
        }),
      ).toBe(CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER);
    }
  });

  test("a Linux host session keeps the sandbox where no container marker is visible", () => {
    for (const hostPolicy of [policy("none"), policy("provider"), policy("none", "pipeline")]) {
      expect(
        codexReadOnlyCommandSandboxOff({
          policy: hostPolicy,
          platform: "linux",
          inContainer: () => false,
        }),
      ).toBeUndefined();
    }
  });

  test("the bridge reads the container markers when no check is injected", () => {
    // Pinned to this host's answer so the test holds on a container CI host.
    const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
    expect(codexReadOnlyCommandSandboxOff({ policy: policy("provider"), platform: "linux" })).toBe(
      inContainer ? CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER : undefined,
    );
  });

  test("a Linux host and macOS keep Codex's sandbox", () => {
    expect(
      codexReadOnlyCommandSandboxOff({
        policy: policy("none"),
        platform: "linux",
        inContainer: () => false,
      }),
    ).toBeUndefined();
    expect(
      codexReadOnlyCommandSandboxOff({ platform: "darwin", inContainer: () => true }),
    ).toBeUndefined();
  });

  test("a coordinator keeps its launcher's permission profile", () => {
    expect(
      codexReadOnlyCommandSandboxOff({
        policy: policy("provider", "coordinator-read-only"),
        platform: "linux",
        inContainer: () => true,
      }),
    ).toBeUndefined();
    expect(
      codexReadOnlyCommandSandboxOff({
        permissionProfile: "orkestrator-coordinator",
        platform: "linux",
        inContainer: () => true,
      }),
    ).toBeUndefined();
  });
});
