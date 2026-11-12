import { describe, expect, test } from "bun:test";
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
  test("a Linux bridge in a container runs read-only turns without the sandbox", () => {
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
