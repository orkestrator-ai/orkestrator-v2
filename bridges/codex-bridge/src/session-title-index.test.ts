import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import { buildPromptWithTranscriptAnnotations } from "@orkestrator/protocol/transcript-annotations";
import {
  buildFallbackSessionTitle,
  persistSessionTitle,
  readPersistedSessionTitleEntries,
  readPersistedSessionTitles,
  sanitizeSessionTitle,
} from "./session-title-index.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix = "orkestrator-session-title-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex session-title index", () => {
  test("builds readable deterministic fallbacks across boundaries", () => {
    expect(buildFallbackSessionTitle("  **Fix** the OAuth callback race, please!  ")).toBe(
      "Fix the OAuth callback race, please",
    );
    expect(buildFallbackSessionTitle("one two three four five six seven eight")).toBe(
      "one two three four five six seven",
    );
    expect(buildFallbackSessionTitle("<tag> `*_#[]{}()`")).toBe("Codex session");
    expect(buildFallbackSessionTitle("Handle emoji 😀 safely!!!")).toBe("Handle emoji 😀 safely");
    expect(buildFallbackSessionTitle("  ")).toBe("Codex session");
  });

  test("derives a fallback from the brief after framed canvas guidance", () => {
    const prompt = `${wrapSystemInstructions("Use the orkestrator-design MCP server. Canvas ID: canvas-1")}\n\nMock up the sidebar`;
    expect(buildFallbackSessionTitle(prompt)).toBe("Mock up the sidebar");
  });

  test("derives a fallback from the request, not the transcript-annotation block", () => {
    const prompt = buildPromptWithTranscriptAnnotations("Review the hero frame", [
      { id: "design-1", text: "Frame Hero at revision 3", comment: "", source: "design" },
    ]);
    expect(buildFallbackSessionTitle(prompt)).toBe("Review the hero frame");
    // Before 0081 the tag pass kept the quoted instruction as the title.
    const annotationsOnly = buildPromptWithTranscriptAnnotations("", [
      { id: "excerpt-1", text: "Quoted output", comment: "" },
    ]);
    expect(buildFallbackSessionTitle(annotationsOnly)).toBe("Codex session");
  });

  test("sanitizes model titles without splitting Unicode", () => {
    expect(sanitizeSessionTitle('```json\n"Fix   OAuth callback race."\n```')).toBe(
      "Fix OAuth callback race",
    );
    expect(sanitizeSessionTitle("`Improve session discovery`")).toBe("Improve session discovery");
    expect(sanitizeSessionTitle("ab")).toBe("ab");
    expect(sanitizeSessionTitle("x")).toBeNull();
    expect(sanitizeSessionTitle("   ...   ")).toBeNull();
    expect(sanitizeSessionTitle("😀".repeat(73))).toBe("😀".repeat(72));
    expect(sanitizeSessionTitle("a".repeat(73))).toBe("a".repeat(72));
  });

  test("reads persistence defensively and selects by source then logical timestamp", async () => {
    const codexHome = createTemporaryDirectory();
    expect(await readPersistedSessionTitles(codexHome)).toEqual(new Map());
    const directory = join(codexHome, "orkestrator-bridge");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "session-titles.jsonl"),
      [
        "",
        "not-json",
        JSON.stringify({ threadId: 3, title: "wrong id" }),
        JSON.stringify({ threadId: "thread", title: "x" }),
        JSON.stringify({ threadId: "thread", title: "bad source", source: "unknown" }),
        JSON.stringify({
          threadId: " thread ",
          title: "Generated newest",
          source: "generated",
          updatedAt: "2026-01-03T00:00:00.000Z",
        }),
        JSON.stringify({
          threadId: "thread",
          title: "Generated older physical last",
          source: "generated",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          threadId: "thread",
          title: "Prompt physical last",
          source: "prompt",
          updatedAt: "2027-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          threadId: "explicit",
          title: "Generated",
          source: "generated",
          updatedAt: "2027-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          threadId: "explicit",
          title: "Explicit",
          source: "explicit",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({ threadId: "legacy", title: "Legacy first" }),
        JSON.stringify({ threadId: "legacy", title: "Legacy last" }),
        JSON.stringify({
          threadId: "dated",
          title: "Valid date",
          source: "generated",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          threadId: "dated",
          title: "Invalid date",
          source: "generated",
          updatedAt: "not-a-date",
        }),
      ].join("\n"),
    );

    expect(await readPersistedSessionTitleEntries(codexHome)).toEqual(
      new Map([
        ["thread", { title: "Generated newest", source: "generated" }],
        ["explicit", { title: "Explicit", source: "explicit" }],
        ["legacy", { title: "Legacy last", source: "generated" }],
        ["dated", { title: "Valid date", source: "generated" }],
      ]),
    );
  });

  test("persists normalized entries, ignores invalid input, and supports concurrent appends", async () => {
    const codexHome = createTemporaryDirectory();
    await persistSessionTitle(codexHome, "  ", "ignored");
    await persistSessionTitle(codexHome, "thread", "x");
    expect(existsSync(join(codexHome, "orkestrator-bridge", "session-titles.jsonl"))).toBe(false);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        persistSessionTitle(codexHome, ` thread-${index} `, `Title ${index}`, {
          source: "generated",
          updatedAt: new Date(2026, 0, index + 1),
        }),
      ),
    );
    const titles = await readPersistedSessionTitles(codexHome);
    expect(titles.size).toBe(20);
    expect(titles.get("thread-0")).toBe("Title 0");

    await expect(
      persistSessionTitle(codexHome, "thread", "Valid title", {
        updatedAt: "not-a-date",
      }),
    ).rejects.toThrow("valid date");
    const blockedHome = join(createTemporaryDirectory(), "file");
    writeFileSync(blockedHome, "blocked");
    await expect(persistSessionTitle(blockedHome, "thread", "Valid title")).rejects.toThrow();
    expect(await readPersistedSessionTitles(blockedHome)).toEqual(new Map());
  });
  test("an added account shares the host's titles and keeps its own earlier ones", async () => {
    const host = createTemporaryDirectory();
    const account = createTemporaryDirectory();
    const saved = process.env.CODEX_BRIDGE_STATE_DIR;
    try {
      // Written on the account before the state directory was shared.
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      await persistSessionTitle(account, "older", "Older title", {
        updatedAt: new Date(2026, 0, 1),
      });
      await persistSessionTitle(account, "both", "Account title", {
        updatedAt: new Date(2026, 0, 1),
      });

      process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
      await persistSessionTitle(account, "both", "Shared title", {
        updatedAt: new Date(2026, 0, 1),
      });
      await persistSessionTitle(account, "newer", "Newer title");
      expect(existsSync(join(host, "orkestrator-bridge", "session-titles.jsonl"))).toBe(true);
      expect(await readPersistedSessionTitles(account)).toEqual(
        new Map([
          ["older", "Older title"],
          ["both", "Shared title"],
          ["newer", "Newer title"],
        ]),
      );

      // The host login's bridge reads what the account's wrote.
      delete process.env.CODEX_BRIDGE_STATE_DIR;
      expect((await readPersistedSessionTitles(host)).get("newer")).toBe("Newer title");
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
      else process.env.CODEX_BRIDGE_STATE_DIR = saved;
    }
  });
});
