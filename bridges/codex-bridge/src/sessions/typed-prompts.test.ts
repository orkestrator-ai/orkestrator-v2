import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_TYPED_PROMPT_CHARS,
  MAX_TYPED_PROMPT_ENTRIES,
  inheritTypedPrompts,
  readTypedPrompts,
  recordTypedPrompt,
  typedPromptDigest,
  typedPromptFor,
  typedPromptJournalPath,
} from "./typed-prompts.js";

const temporaryDirectories: string[] = [];

async function temporaryCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "typed-prompts-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("typed prompts", () => {
  test("a record answers only its own turn and the exact text that was sent", async () => {
    const codexHome = await temporaryCodexHome();
    await recordTypedPrompt(codexHome, "thread-1", "turn-1", "$tidy now\n", "/skill:tidy now");
    const prompts = await readTypedPrompts(codexHome, "thread-1");

    // The rollout's text is compared trimmed, as the reader joins it.
    expect(typedPromptFor(prompts, "turn-1", "$tidy now")).toBe("/skill:tidy now");
    expect(typedPromptFor(prompts, "turn-1", "$tidy later")).toBeUndefined();
    expect(typedPromptFor(prompts, "turn-2", "$tidy now")).toBeUndefined();
    expect(typedPromptFor(prompts, undefined, "$tidy now")).toBeUndefined();
    expect((await readTypedPrompts(codexHome, "thread-2")).size).toBe(0);
    // Only a digest of what was sent is kept, never the sent text itself.
    const file = await readFile(typedPromptJournalPath(codexHome, "thread-1")!, "utf8");
    expect(file).not.toContain("$tidy now");
    expect(file).toContain(typedPromptDigest("$tidy now"));
  });

  test("nothing is written when the typed text is what was sent, or too long to keep", async () => {
    const codexHome = await temporaryCodexHome();
    await recordTypedPrompt(codexHome, "thread-1", "turn-1", "same", "same");
    await recordTypedPrompt(
      codexHome,
      "thread-1",
      "turn-2",
      "sent",
      "x".repeat(MAX_TYPED_PROMPT_CHARS + 1),
    );
    await recordTypedPrompt(codexHome, "thread-1", "", "sent", "typed");
    expect(await stat(typedPromptJournalPath(codexHome, "thread-1")!).catch(() => null)).toBeNull();
  });

  test("malformed lines are skipped and the newest record for a turn wins", async () => {
    const codexHome = await temporaryCodexHome();
    const path = typedPromptJournalPath(codexHome, "thread-1")!;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      [
        "not json",
        JSON.stringify({ turnId: "turn-1", sent: "short", typed: "bad digest" }),
        JSON.stringify({ turnId: "turn-1", sent: typedPromptDigest("a"), typed: 7 }),
        JSON.stringify({ turnId: "turn-1", sent: typedPromptDigest("a"), typed: "first" }),
        "",
      ].join("\n"),
    );
    await recordTypedPrompt(codexHome, "thread-1", "turn-1", "a", "second");
    const prompts = await readTypedPrompts(codexHome, "thread-1");
    expect([...prompts.values()]).toEqual([
      { turnId: "turn-1", sent: typedPromptDigest("a"), typed: "second" },
    ]);
  });

  test("a thread keeps only its newest records, compacting the file", async () => {
    const codexHome = await temporaryCodexHome();
    const total = 2 * MAX_TYPED_PROMPT_ENTRIES + 5;
    for (let index = 0; index < total; index += 1) {
      void recordTypedPrompt(
        codexHome,
        "thread-1",
        `turn-${index}`,
        `sent ${index}`,
        `/t ${index}`,
      );
    }
    const prompts = await readTypedPrompts(codexHome, "thread-1");
    expect(prompts.size).toBe(MAX_TYPED_PROMPT_ENTRIES);
    expect(prompts.has("turn-0")).toBe(false);
    expect(typedPromptFor(prompts, `turn-${total - 1}`, `sent ${total - 1}`)).toBe(
      `/t ${total - 1}`,
    );
    const lines = (await readFile(typedPromptJournalPath(codexHome, "thread-1")!, "utf8"))
      .split("\n")
      .filter(Boolean);
    // Compacted every `MAX_TYPED_PROMPT_ENTRIES` appends, so never twice that.
    expect(lines.length).toBeLessThan(2 * MAX_TYPED_PROMPT_ENTRIES);
  });

  test("a fork inherits its parent's records without touching the parent's", async () => {
    const codexHome = await temporaryCodexHome();
    await recordTypedPrompt(codexHome, "parent", "turn-1", "$tidy", "/skill:tidy");
    await inheritTypedPrompts(codexHome, "parent", "fork");
    await inheritTypedPrompts(codexHome, "empty-parent", "fork-2");
    expect(typedPromptFor(await readTypedPrompts(codexHome, "fork"), "turn-1", "$tidy")).toBe(
      "/skill:tidy",
    );
    expect((await readTypedPrompts(codexHome, "parent")).size).toBe(1);
    expect(await stat(typedPromptJournalPath(codexHome, "fork-2")!).catch(() => null)).toBeNull();
  });

  test("an unusable thread id records and reads nothing", async () => {
    const codexHome = await temporaryCodexHome();
    expect(typedPromptJournalPath(codexHome, "..")).toBeUndefined();
    await recordTypedPrompt(codexHome, "..", "turn-1", "sent", "typed");
    expect((await readTypedPrompts(codexHome, "..")).size).toBe(0);
    expect(typedPromptJournalPath(codexHome, "../escape")).toEndWith(
      join("typed-prompts", ".._escape.jsonl"),
    );
  });
});
