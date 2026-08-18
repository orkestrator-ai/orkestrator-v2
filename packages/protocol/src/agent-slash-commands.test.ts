import { describe, expect, test } from "bun:test";
import {
  isProviderSlashCommand,
  parseLeadingSlashCommand,
  resolveSessionActionCommand,
  withSessionActionSlashCommands,
} from "./agent-slash-commands.js";
import type { NativeAgentCapabilities } from "./native-agent.js";

function capabilities(actions: NativeAgentCapabilities["actions"]): NativeAgentCapabilities {
  return {
    attachments: { files: true, images: true },
    queue: true,
    resume: true,
    fork: true,
    slashCommands: true,
    backgroundTasks: false,
    composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
    actions,
  };
}

describe("parseLeadingSlashCommand", () => {
  test("returns null for ordinary prompts", () => {
    expect(parseLeadingSlashCommand("fix the failing test")).toBeNull();
    expect(parseLeadingSlashCommand("  ")).toBeNull();
  });

  test("lower-cases the name and keeps multi-line arguments intact", () => {
    const parsed = parseLeadingSlashCommand("/Steer  keep the diff small\n\nand rerun tests");
    expect(parsed?.name).toBe("/steer");
    // A `split(/\s+/).join(" ")` round trip used to flatten pasted diffs and
    // multi-line specs into a single line.
    expect(parsed?.arguments).toBe("keep the diff small\n\nand rerun tests");
  });

  test("reports a bare command with no arguments", () => {
    expect(parseLeadingSlashCommand("/init")).toEqual({ name: "/init" });
  });
});

describe("resolveSessionActionCommand", () => {
  const steerCapable = capabilities({ steer: true });

  test("routes /steer to the steer action while a turn is running", () => {
    expect(resolveSessionActionCommand("/steer use the cache", steerCapable, true)).toEqual({
      kind: "steer",
      text: "use the cache",
    });
  });

  test("is an ordinary prompt when no turn is running", () => {
    expect(resolveSessionActionCommand("/steer use the cache", steerCapable, false)).toBeNull();
  });

  test("is an ordinary prompt for a provider that cannot steer", () => {
    expect(
      resolveSessionActionCommand("/steer use the cache", capabilities({ compact: true }), true),
    ).toBeNull();
  });

  test("refuses a bare /steer with an explanation rather than steering nothing", () => {
    const resolved = resolveSessionActionCommand("/steer", steerCapable, true);
    expect(resolved?.error).toBe("Add instructions after /steer.");
    expect(resolved?.text).toBe("");
  });
});

describe("isProviderSlashCommand", () => {
  const commands = [{ name: "/help", description: "Provider help" }];

  test("matches only discovered provider commands", () => {
    expect(isProviderSlashCommand("/help topic", commands)).toBe(true);
    expect(isProviderSlashCommand("/unknown topic", commands)).toBe(false);
    expect(isProviderSlashCommand("/Users/me/file.ts is broken", commands)).toBe(false);
  });

  test("excludes runtime session actions from handoff-consuming commands", () => {
    expect(
      isProviderSlashCommand(
        "/steer keep going",
        [{ name: "/steer", description: "runtime action" }],
        capabilities({ steer: true }),
      ),
    ).toBe(false);
  });
});

describe("withSessionActionSlashCommands", () => {
  test("advertises runtime actions the provider supports", () => {
    const merged = withSessionActionSlashCommands(
      [{ name: "/review", description: "Review changes" }],
      capabilities({ steer: true }),
    );
    expect(merged.map((command) => command.name)).toEqual(["/review", "/steer"]);
  });

  test("removes an action command a provider cannot perform", () => {
    const merged = withSessionActionSlashCommands(
      [{ name: "/steer", description: "stale discovery entry" }],
      capabilities({ compact: true }),
    );
    expect(merged).toEqual([]);
  });

  test("adds the action even when the provider discovered nothing", () => {
    expect(withSessionActionSlashCommands([], capabilities({ steer: true }))).toEqual([
      expect.objectContaining({ name: "/steer" }),
    ]);
  });
});
