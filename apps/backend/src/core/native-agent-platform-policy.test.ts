import { describe, expect, test } from "bun:test";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";

describe("nativeAgentPlatformPolicy", () => {
  test("only OpenCode infers its composer selection, and no platform recovers incomplete turns", () => {
    for (const agent of BUILD_PIPELINE_AGENTS) {
      const policy = nativeAgentPlatformPolicy(agent);
      // OpenCode 1.x's continuation read 1.x `{ info, parts }` messages; OpenCode
      // 2 reports each run's outcome on its `idle` row.
      expect(policy.incompleteTurnRecovery).toBeUndefined();
      if (agent === "opencode") expect(policy.infersComposerSelection).toBe(true);
      else expect(policy.infersComposerSelection).toBeUndefined();
    }
  });
});
