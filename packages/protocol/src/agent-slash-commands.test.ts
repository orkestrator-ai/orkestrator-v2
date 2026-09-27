import { describe, expect, test } from "bun:test";
import {
  idleSteerPromptReply,
  isProviderSlashCommand,
  parseLeadingSlashCommand,
  parseCommandToken,
  resolveCommandInvocation,
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

describe("idleSteerPromptReply", () => {
  test("answers an idle /steer locally instead of starting a turn", () => {
    expect(idleSteerPromptReply("/steer keep going", "Claude")).toBe(
      "There is no active Claude turn to steer. Start a turn, then use /steer while it is running.",
    );
    expect(idleSteerPromptReply("/steer", "Cursor")).toBe(
      "Usage: /steer <instructions>. Run it while a Cursor turn is active.",
    );
  });

  test("leaves unrelated prompts alone", () => {
    expect(idleSteerPromptReply("please /steer this", "Pi")).toBeNull();
    expect(idleSteerPromptReply("/review the diff", "Pi")).toBeNull();
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
  const commands = [{ name: "/help", description: "Provider help", source: "builtin" as const }];

  test("matches only discovered provider commands", () => {
    expect(isProviderSlashCommand("/help topic", commands)).toBe(true);
    expect(isProviderSlashCommand("/unknown topic", commands)).toBe(false);
    expect(isProviderSlashCommand("/Users/me/file.ts is broken", commands)).toBe(false);
  });

  test("excludes runtime session actions from handoff-consuming commands", () => {
    expect(
      isProviderSlashCommand(
        "/steer keep going",
        [{ name: "/steer", description: "runtime action", source: "builtin" }],
        capabilities({ steer: true }),
      ),
    ).toBe(false);
  });
});

describe("withSessionActionSlashCommands", () => {
  test("advertises runtime actions the provider supports", () => {
    const merged = withSessionActionSlashCommands(
      [{ name: "/review", description: "Review changes", source: "builtin" }],
      capabilities({ steer: true }),
    );
    expect(merged.map((command) => command.name)).toEqual(["/review", "/steer"]);
    expect(merged.find((command) => command.name === "/steer")).toMatchObject({
      id: "orkestrator:steer",
      executionKind: "session-action",
      inputPolicy: { arguments: "required", attachments: "none", busy: "running" },
    });
  });

  test("keeps a provider's own command when the same-named action is unavailable", () => {
    // The old merge deleted any `/steer` whenever steering was unqualified,
    // silently removing a provider command the user could still run.
    const merged = withSessionActionSlashCommands(
      [{ name: "/steer", description: "provider command", source: "builtin" }],
      capabilities({}),
    );
    expect(merged).toEqual([
      expect.objectContaining({ name: "/steer", description: "provider command" }),
    ]);
  });

  test("reserves /steer for the qualified runtime action", () => {
    const merged = withSessionActionSlashCommands(
      [{ name: "/steer", description: "provider command", source: "builtin" }],
      capabilities({ steer: true }),
    );
    expect(merged).toEqual([
      expect.objectContaining({ name: "/steer", id: "orkestrator:steer", source: "orkestrator" }),
    ]);
  });

  test("a provider's own /compact wins over the compact action", () => {
    const provider = { name: "/compact", source: "builtin" as const, id: "claude:/compact" };
    const merged = withSessionActionSlashCommands([provider], capabilities({ compact: true }));
    expect(merged).toEqual([expect.objectContaining({ id: "claude:/compact" })]);
  });

  test("offers the compact action when the provider has no compact command", () => {
    const merged = withSessionActionSlashCommands([], capabilities({ compact: true }));
    expect(merged).toEqual([
      expect.objectContaining({
        name: "/compact",
        id: "orkestrator:compact",
        inputPolicy: { arguments: "none", attachments: "none", busy: "idle" },
      }),
    ]);
  });

  test("adds the action even when the provider discovered nothing", () => {
    expect(withSessionActionSlashCommands([], capabilities({ steer: true }))).toEqual([
      expect.objectContaining({ name: "/steer" }),
    ]);
  });

  test("deduplicates by identity rather than lower-cased display name", () => {
    const merged = withSessionActionSlashCommands(
      [
        { name: "/Deploy", source: "project", id: "a" },
        { name: "/deploy", source: "user", id: "b" },
      ],
      capabilities({}),
    );
    expect(merged.map((command) => command.id)).toEqual(["a", "b"]);
  });
});

describe("parseCommandToken", () => {
  test("keeps the token's spelling and the argument suffix byte-for-byte", () => {
    expect(parseCommandToken('/Deploy  staging "quoted"  ')).toEqual({
      token: "/Deploy",
      sigil: "/",
      start: 0,
      argumentsStart: 9,
      arguments: 'staging "quoted"  ',
    });
  });

  test("tabs and a single newline separate; later newlines belong to the arguments", () => {
    expect(parseCommandToken("/cmd\targ")?.arguments).toBe("arg");
    expect(parseCommandToken("/cmd\nline one\n\nline two")?.arguments).toBe("line one\n\nline two");
    expect(parseCommandToken("/cmd\r\n\nnext")?.arguments).toBe("\nnext");
    expect(parseCommandToken("  /cmd x")).toMatchObject({ start: 2, arguments: "x" });
  });

  test("recognises only the requested sigils", () => {
    expect(parseCommandToken("$skill do it")).toBeNull();
    expect(parseCommandToken("$skill do it", ["/", "$"])?.token).toBe("$skill");
    expect(parseCommandToken("/")).toBeNull();
    expect(parseCommandToken("plain text")).toBeNull();
  });
});

describe("resolveCommandInvocation", () => {
  const commands = [
    { name: "/review", source: "project" as const, id: "review", bindingRevision: "r1" },
    {
      name: "/plugin:Deploy",
      source: "plugin" as const,
      id: "deploy",
      aliases: ["/ship"],
      bindingRevision: "d1",
    },
    {
      name: "$lint",
      insertText: "$lint",
      aliases: ["/skill:lint"],
      source: "skill" as const,
      id: "lint",
      executionKind: "structured-skill" as const,
    },
    {
      name: "/off",
      source: "user" as const,
      id: "off",
      availability: { state: "unavailable" as const, reason: "disabled" as const, message: "Off" },
    },
    {
      name: "/needs",
      source: "user" as const,
      id: "needs",
      inputPolicy: { arguments: "required" as const },
    },
    { name: "/Case", source: "user" as const, id: "upper", caseSensitive: true },
    { name: "/case", source: "user" as const, id: "lower", caseSensitive: true },
    { name: "/dup", source: "user" as const, id: "dup1" },
    { name: "/DUP", source: "project" as const, id: "dup2" },
  ];
  const typed = { kind: "typed" as const };

  test("literal intent never matches", () => {
    expect(
      resolveCommandInvocation({ text: "/review", intent: { kind: "literal" }, commands }),
    ).toEqual({
      kind: "literal",
      reason: "literal-intent",
    });
  });

  test("unknown tokens and leading paths stay ordinary text", () => {
    expect(resolveCommandInvocation({ text: "/unknown x", intent: typed, commands }).kind).toBe(
      "literal",
    );
    expect(
      resolveCommandInvocation({ text: "/Users/me/file.ts is broken", intent: typed, commands })
        .kind,
    ).toBe("literal");
    expect(resolveCommandInvocation({ text: "no command", intent: typed, commands })).toEqual({
      kind: "literal",
      reason: "no-token",
    });
  });

  test("exact name, folded name and alias resolve to the canonical descriptor", () => {
    const exact = resolveCommandInvocation({ text: "/review now", intent: typed, commands });
    expect(exact).toMatchObject({ kind: "command", matchedBy: "name", command: { id: "review" } });
    const folded = resolveCommandInvocation({ text: "/PLUGIN:deploy", intent: typed, commands });
    expect(folded).toMatchObject({ kind: "command", command: { name: "/plugin:Deploy" } });
    const alias = resolveCommandInvocation({ text: "/ship prod", intent: typed, commands });
    expect(alias).toMatchObject({ kind: "command", matchedBy: "alias", command: { id: "deploy" } });
    expect(alias.kind === "command" && alias.token.arguments).toBe("prod");
    const skill = resolveCommandInvocation({ text: "$lint fix", intent: typed, commands });
    expect(skill).toMatchObject({ kind: "command", command: { id: "lint" } });
    const compat = resolveCommandInvocation({ text: "/skill:lint", intent: typed, commands });
    expect(compat).toMatchObject({ kind: "command", command: { id: "lint" } });
  });

  test("case-sensitive descriptors match only their exact spelling", () => {
    expect(resolveCommandInvocation({ text: "/Case", intent: typed, commands })).toMatchObject({
      command: { id: "upper" },
    });
    expect(resolveCommandInvocation({ text: "/CASE", intent: typed, commands }).kind).toBe(
      "literal",
    );
  });

  test("more than one candidate is ambiguous rather than chosen by sort order", () => {
    const resolution = resolveCommandInvocation({ text: "/Dup", intent: typed, commands });
    expect(resolution.kind).toBe("ambiguous");
    // An exact spelling is not ambiguous.
    expect(resolveCommandInvocation({ text: "/dup", intent: typed, commands })).toMatchObject({
      command: { id: "dup1" },
    });
  });

  test("a shadowed row never competes with the executable row of the same name", () => {
    const shadowed = [
      { name: "/deploy", source: "extension" as const, id: "ext" },
      {
        name: "/deploy",
        source: "template" as const,
        id: "tpl",
        availability: { state: "unavailable" as const, reason: "shadowed" as const },
      },
    ];
    expect(
      resolveCommandInvocation({ text: "/deploy", intent: typed, commands: shadowed }),
    ).toMatchObject({ kind: "command", command: { id: "ext" } });
  });

  test("known unavailable commands and argument policy fail before dispatch", () => {
    expect(resolveCommandInvocation({ text: "/off", intent: typed, commands })).toMatchObject({
      kind: "unavailable",
      message: "Off",
    });
    expect(resolveCommandInvocation({ text: "/needs", intent: typed, commands }).kind).toBe(
      "invalid-arguments",
    );
    expect(resolveCommandInvocation({ text: "/needs   \n ", intent: typed, commands }).kind).toBe(
      "invalid-arguments",
    );
  });

  test("a selection resolves by identity and fails when stale", () => {
    const selected = (commandId: string, bindingRevision?: string) => ({
      kind: "selected" as const,
      commandId,
      ...(bindingRevision ? { bindingRevision } : {}),
    });
    expect(
      resolveCommandInvocation({ text: "/review x", intent: selected("review", "r1"), commands }),
    ).toMatchObject({ kind: "command", matchedBy: "selection" });
    expect(
      resolveCommandInvocation({ text: "/review x", intent: selected("gone"), commands }).kind,
    ).toBe("stale-selection");
    expect(
      resolveCommandInvocation({ text: "/review x", intent: selected("review", "r0"), commands })
        .kind,
    ).toBe("stale-selection");
    // The token was edited to a different command after selection.
    expect(
      resolveCommandInvocation({ text: "/ship x", intent: selected("review"), commands }).kind,
    ).toBe("stale-selection");
    expect(resolveCommandInvocation({ text: "/off", intent: selected("off"), commands }).kind).toBe(
      "unavailable",
    );
  });
});
