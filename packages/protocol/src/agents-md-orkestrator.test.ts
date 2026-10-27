import { describe, expect, test } from "bun:test";
import {
  AgentsMdSectionError,
  MAX_AGENTS_MD_CHANGES,
  ORKESTRATOR_SECTION_NOTE,
  agentsMdEntryKey,
  describeAgentsMdChange,
  diffAgentsMdLines,
  mergeOrkestratorSection,
  parseAgentsMdChanges,
  readOrkestratorSection,
  validateAgentsMdEntry,
  type AgentsMdChange,
} from "./agents-md-orkestrator.js";

const add = (text: string): AgentsMdChange => ({ action: "add", text });
const remove = (text: string): AgentsMdChange => ({ action: "remove", text });
const replace = (replaces: string, text: string): AgentsMdChange => ({
  action: "replace",
  text,
  replaces,
});

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof AgentsMdSectionError ? error.code : "other";
  }
}

const DOC = [
  "# Agent Instructions",
  "",
  "Intro.",
  "",
  "## Orkestrator",
  "",
  "Preamble line.",
  "",
  "- Never touch ports 34121/34122.",
  "- Commit flaky-test records in the same change.",
  "",
  "## Testing",
  "",
  "```bash",
  "# not a heading",
  "```",
  "",
].join("\n");

describe("readOrkestratorSection", () => {
  test("reads entries and the exact section text", () => {
    const section = readOrkestratorSection(DOC);
    expect(section.exists).toBe(true);
    expect(section.entries).toEqual([
      "Never touch ports 34121/34122.",
      "Commit flaky-test records in the same change.",
    ]);
    expect(section.text?.startsWith("## Orkestrator\n")).toBe(true);
    expect(section.text?.includes("## Testing")).toBe(false);
  });

  test("a missing file or section has no entries", () => {
    expect(readOrkestratorSection(null)).toEqual({ exists: false, text: null, entries: [] });
    expect(readOrkestratorSection("# Title\n\ntext\n").exists).toBe(false);
  });

  test("a heading inside a code fence neither starts nor ends the section", () => {
    const content = [
      "# Top",
      "```md",
      "## Orkestrator",
      "```",
      "## Orkestrator",
      "- one",
      "```",
      "## not the end",
      "```",
      "- two",
      "# Next",
    ].join("\n");
    const section = readOrkestratorSection(content);
    expect(section.entries).toEqual(["one", "two"]);
  });

  test("multi-line bullets read as one entry", () => {
    const section = readOrkestratorSection("## Orkestrator\n- first part\n  second part\n- next\n");
    expect(section.entries).toEqual(["first part second part", "next"]);
  });

  test("two sections are ambiguous", () => {
    expect(errorCode(() => readOrkestratorSection("## Orkestrator\n- a\n## orkestrator\n"))).toBe(
      "ambiguous-section",
    );
  });
});

describe("mergeOrkestratorSection", () => {
  test("preserves everything outside the section byte for byte", () => {
    const result = mergeOrkestratorSection(DOC, [add("Use bun, never npm.")]);
    expect(result.changed).toBe(true);
    const start = DOC.indexOf("## Orkestrator");
    const end = DOC.indexOf("## Testing");
    expect(result.content.slice(0, start)).toBe(DOC.slice(0, start));
    expect(result.content.endsWith(DOC.slice(end))).toBe(true);
    expect(result.entriesAfter).toEqual([
      "Never touch ports 34121/34122.",
      "Commit flaky-test records in the same change.",
      "Use bun, never npm.",
    ]);
    expect(result.content).toContain(
      "- Commit flaky-test records in the same change.\n- Use bun, never npm.\n\n## Testing",
    );
  });

  test("creates the section at the end when it is missing", () => {
    const content = "# Agent Instructions\n\nRules.";
    const result = mergeOrkestratorSection(content, [add("One"), add("Two")]);
    expect(result.createdSection).toBe(true);
    expect(result.content).toBe(
      `# Agent Instructions\n\nRules.\n\n## Orkestrator\n\n${ORKESTRATOR_SECTION_NOTE}\n\n- One\n- Two\n`,
    );
    expect(result.content.startsWith(content)).toBe(true);
  });

  test("creates the file when there is none", () => {
    const result = mergeOrkestratorSection(null, [add("One")]);
    expect(result.createdFile).toBe(true);
    expect(result.content).toBe(`## Orkestrator\n\n${ORKESTRATOR_SECTION_NOTE}\n\n- One\n`);
  });

  test("keeps CRLF line endings", () => {
    const content = "# T\r\n\r\n## Orkestrator\r\n\r\n- a\r\n\r\n## Next\r\n";
    const result = mergeOrkestratorSection(content, [add("b")]);
    expect(result.content).toBe("# T\r\n\r\n## Orkestrator\r\n\r\n- a\r\n- b\r\n\r\n## Next\r\n");
  });

  test("adds to an empty section after its preamble", () => {
    const content = "## Orkestrator\n\nNote.\n\n## Next\n";
    expect(mergeOrkestratorSection(content, [add("a")]).content).toBe(
      "## Orkestrator\n\nNote.\n\n- a\n\n## Next\n",
    );
  });

  test("a section at the end of a file without a final newline gains one", () => {
    const content = "# T\n\n## Orkestrator\n- a";
    expect(mergeOrkestratorSection(content, [add("b")]).content).toBe(
      "# T\n\n## Orkestrator\n- a\n- b\n",
    );
  });

  test("de-duplicates: an existing entry is not added twice, case and spacing ignored", () => {
    const result = mergeOrkestratorSection(DOC, [add("never  touch ports 34121/34122")]);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(DOC);
    expect(result.outcomes[0]?.result).toBe("already");
  });

  test("existing duplicates collapse to the first when the section changes", () => {
    const content = "## Orkestrator\n- a\n- b\n- A.\n";
    const result = mergeOrkestratorSection(content, [add("c")]);
    expect(result.entriesAfter).toEqual(["a", "b", "c"]);
  });

  test("replace keeps the entry's position; remove drops it", () => {
    const result = mergeOrkestratorSection(DOC, [
      replace("Never touch ports 34121/34122.", "Never bind ports 34121 or 34122."),
      remove("Commit flaky-test records in the same change."),
      add("Use bun."),
    ]);
    expect(result.entriesAfter).toEqual(["Never bind ports 34121 or 34122.", "Use bun."]);
    expect(result.content).toContain(
      "Preamble line.\n\n- Never bind ports 34121 or 34122.\n- Use bun.\n",
    );
  });

  test("re-applied to a changed base: already-done changes are no-ops", () => {
    // Upstream removed the entry and added the replacement meanwhile.
    const upstream = "## Orkestrator\n\n- Never bind ports 34121 or 34122.\n";
    const result = mergeOrkestratorSection(upstream, [
      replace("Never touch ports 34121/34122.", "Never bind ports 34121 or 34122."),
      remove("Gone already"),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.changed).toBe(false);
  });

  test("a replacement whose original disappeared upstream is a conflict", () => {
    const upstream = "## Orkestrator\n\n- Something else\n";
    const result = mergeOrkestratorSection(upstream, [
      add("New rule"),
      replace("Never touch ports 34121/34122.", "Never bind ports."),
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.detail).toContain("no longer in the section");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(upstream);
  });

  test("bullets inside a fence in the section are not entries", () => {
    const content = "## Orkestrator\n\n```\n- not an entry\n```\n\n- real\n";
    const result = mergeOrkestratorSection(content, [remove("not an entry")]);
    expect(result.changed).toBe(false);
    expect(readOrkestratorSection(content).entries).toEqual(["real"]);
  });

  test("refuses a file over the size bound", () => {
    expect(errorCode(() => mergeOrkestratorSection("x".repeat(1024 * 1024 + 1), [add("a")]))).toBe(
      "too-large",
    );
  });
});

describe("parseAgentsMdChanges", () => {
  test("normalizes text and strips one typed bullet", () => {
    expect(parseAgentsMdChanges([{ action: "add", text: "  -  Use   bun\t now " }])).toEqual([
      { action: "add", text: "Use bun now" },
    ]);
  });

  test("refuses heading, fence, HTML and multi-line injection", () => {
    for (const text of [
      "first\n## Evil",
      "first\r\n# Evil",
      "line ## Evil",
      "## Evil heading",
      "# Evil",
      "- - nested list",
      "```js",
      "~~~",
      "> quote",
      "<details>",
      "| table |",
      "1. ordered",
      "---",
      "***",
      "text <!-- hidden",
      "bell \u0007",
      "bidi ‮ override",
      "",
      "   ",
      "x".repeat(501),
    ]) {
      expect(errorCode(() => parseAgentsMdChanges([{ action: "add", text }]))).toBe(
        "invalid-input",
      );
    }
  });

  test("a heading marker inside a line is harmless text", () => {
    expect(validateAgentsMdEntry("Prefer `## Notes` headings in docs")).toBe(
      "Prefer `## Notes` headings in docs",
    );
  });

  test("bounds and shape", () => {
    expect(errorCode(() => parseAgentsMdChanges([]))).toBe("invalid-input");
    expect(
      errorCode(() =>
        parseAgentsMdChanges(
          Array.from({ length: MAX_AGENTS_MD_CHANGES + 1 }, (_, i) => add(`r${i}`)),
        ),
      ),
    ).toBe("invalid-input");
    expect(errorCode(() => parseAgentsMdChanges([{ action: "add", text: "a", path: "x" }]))).toBe(
      "invalid-input",
    );
    expect(errorCode(() => parseAgentsMdChanges([{ action: "replace", text: "a" }]))).toBe(
      "invalid-input",
    );
    expect(
      errorCode(() => parseAgentsMdChanges([{ action: "add", text: "a", replaces: "b" }])),
    ).toBe("invalid-input");
    expect(errorCode(() => parseAgentsMdChanges([{ action: "edit", text: "a" }]))).toBe(
      "invalid-input",
    );
  });

  test("two changes may not touch the same entry", () => {
    expect(errorCode(() => parseAgentsMdChanges([add("a"), add("A.")]))).toBe("invalid-input");
    expect(errorCode(() => parseAgentsMdChanges([replace("a", "b"), remove("a")]))).toBe(
      "invalid-input",
    );
    expect(errorCode(() => parseAgentsMdChanges([replace("a", "a.")]))).toBe("invalid-input");
  });

  test("keys ignore case, spacing and a final full stop", () => {
    expect(agentsMdEntryKey("Use  Bun.")).toBe(agentsMdEntryKey("use bun"));
  });
});

describe("diffAgentsMdLines", () => {
  test("marks added and removed lines", () => {
    expect(diffAgentsMdLines("a\nb\nc\n", "a\nc\nd\n")).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
  });

  test("an empty before is all additions", () => {
    expect(diffAgentsMdLines("", "x\n").map((line) => line.type)).toEqual(["add"]);
  });
});

test("describeAgentsMdChange names each action", () => {
  expect(describeAgentsMdChange(replace("a", "b"))).toBe("Replace: “a” → “b”");
  expect(describeAgentsMdChange(add("a"))).toBe("Add: a");
  expect(describeAgentsMdChange(remove("a"))).toBe("Remove: a");
});

describe("section boundary regressions", () => {
  for (const underline of ["===", "---"]) {
    test(`preserves a following Setext section (${underline}) for every action`, () => {
      const suffix = `Testing\n${underline}\n\n- Outside rule.\n`;
      const original = `## Orkestrator\n\n- Inside rule.\n\n${suffix}`;
      for (const change of [
        add("Another rule."),
        replace("Inside rule.", "Updated rule."),
        remove("Inside rule."),
        remove("Outside rule."),
      ]) {
        const merged = mergeOrkestratorSection(original, [change]);
        expect(merged.content.endsWith(suffix)).toBe(true);
        expect(merged.entriesAfter).not.toContain("Outside rule.");
      }
    });
  }
  test("Setext-looking text inside a fence does not end the section", () => {
    const original = "## Orkestrator\n\n```md\nTesting\n---\n```\n\n- Inside rule.\n";
    expect(
      mergeOrkestratorSection(original, [replace("Inside rule.", "Updated rule.")]).content,
    ).toContain("- Updated rule.");
  });
  test("BOM-prefixed first heading stays unique with the BOM intact", () => {
    for (const change of [
      add("Another rule."),
      replace("Inside rule.", "Updated rule."),
      remove("Inside rule."),
    ]) {
      const merged = mergeOrkestratorSection("\uFEFF## Orkestrator\n\n- Inside rule.\n", [change]);
      expect(merged.content.startsWith("\uFEFF## Orkestrator")).toBe(true);
      expect(merged.content.match(/## Orkestrator/g)).toHaveLength(1);
      expect(merged.createdSection).toBe(false);
      expect(readOrkestratorSection(merged.content).exists).toBe(true);
    }
  });
  test("format characters and compatibility block markers cannot hide entries", () => {
    for (const text of [
      "\u200B## Hidden",
      "Rule.\u200B",
      "\u2060Rule",
      "＃＃ Hidden",
      "＞ Hidden",
      "＜!-- Hidden --＞",
    ])
      expect(() => validateAgentsMdEntry(text)).toThrow();
    expect(agentsMdEntryKey("Rule.\u200B")).toBe(agentsMdEntryKey("Rule."));
    expect(agentsMdEntryKey("Ｒｕｌｅ.")).toBe(agentsMdEntryKey("Rule."));
  });
});
