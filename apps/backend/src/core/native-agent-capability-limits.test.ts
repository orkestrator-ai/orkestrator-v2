import { expect, test } from "bun:test";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { limitNativeAgentCapabilities } from "./native-agent-capability-limits.js";
import { OPENCODE2_CAPABILITY_LIMITS } from "./opencode2/routing-provider.js";

test("no limits leaves the platform's capabilities untouched", () => {
  const capabilities = nativeAgentCapabilities("opencode");
  expect(limitNativeAgentCapabilities(capabilities, undefined)).toBe(capabilities);
});

test("an OpenCode 2.x session loses the 1.x actions and keeps steer", () => {
  const limited = limitNativeAgentCapabilities(
    nativeAgentCapabilities("opencode"),
    OPENCODE2_CAPABILITY_LIMITS,
  );
  expect(limited.actions).toMatchObject({
    compact: false,
    undo: false,
    redo: false,
    steer: true,
  });
  expect(limited.attachments).toEqual({ files: false, images: false });
  expect(limited.slashCommands).toBe(false);
  expect(limited.fork).toBe(false);
  // Narrowing never adds an action the table did not have.
  expect("rewindMessages" in limited.actions!).toBe(false);
});
