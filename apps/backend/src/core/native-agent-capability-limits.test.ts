import { expect, test } from "bun:test";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { limitNativeAgentCapabilities } from "./native-agent-capability-limits.js";
import { OPENCODE2_CAPABILITY_LIMITS } from "./opencode2/environment-provider.js";

test("no limits leaves the platform's capabilities untouched", () => {
  const capabilities = nativeAgentCapabilities("opencode");
  expect(limitNativeAgentCapabilities(capabilities, undefined)).toBe(capabilities);
});

test("limits remove actions, attachments, slash commands and fork, and never add", () => {
  const limited = limitNativeAgentCapabilities(nativeAgentCapabilities("opencode"), {
    withoutActions: ["compact", "undo", "redo", "rewindMessages"],
    withoutAttachments: true,
    withoutSlashCommands: true,
    withoutFork: true,
  });
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

test("an OpenCode session keeps compact, undo, redo, attachments, commands and fork", () => {
  const limited = limitNativeAgentCapabilities(
    nativeAgentCapabilities("opencode"),
    OPENCODE2_CAPABILITY_LIMITS,
  );
  expect(limited.actions).toMatchObject({ compact: true, undo: true, redo: true, steer: true });
  expect(limited.attachments).toEqual({ files: true, images: true });
  expect(limited.slashCommands).toBe(true);
  expect(limited.fork).toBe(true);
  expect("rewindMessages" in limited.actions!).toBe(false);
  expect("share" in limited.actions!).toBe(false);
});
