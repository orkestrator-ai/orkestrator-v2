import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_TYPED_PROMPT_CHARS,
  inheritTypedPrompts,
  readTypedPrompt,
  recordTypedPrompt,
  typedPromptDigest,
  typedPromptFor,
  typedPromptRecordPath,
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
  test("a record answers only its own turn and exact sent text", async () => {
    const home = await temporaryCodexHome();
    // Read immediately, without waiting for the background write.
    const pending = recordTypedPrompt(home, "thread", "turn-1", "$tidy now\n", "/skill:tidy now");
    const record = await readTypedPrompt(home, "thread", "turn-1");
    await pending;
    expect(typedPromptFor(record, "$tidy now")).toBe("/skill:tidy now");
    expect(typedPromptFor(record, "$tidy later")).toBeUndefined();
    expect(await readTypedPrompt(home, "thread", "turn-2")).toBeUndefined();
    expect(await readTypedPrompt(home, "thread", undefined)).toBeUndefined();
    expect(await readTypedPrompt(home, "other", "turn-1")).toBeUndefined();
    const file = await readFile(typedPromptRecordPath(home, "thread", "turn-1")!, "utf8");
    expect(file).not.toContain("$tidy now");
    expect(file).toContain(typedPromptDigest("$tidy now"));
    expect((await stat(typedPromptRecordPath(home, "thread", "turn-1")!)).mode & 0o777).toBe(0o600);
  });

  test("unchanged, oversized and invalid records are not written", async () => {
    const home = await temporaryCodexHome();
    await recordTypedPrompt(home, "thread", "turn-1", "same", "same");
    await recordTypedPrompt(
      home,
      "thread",
      "turn-2",
      "sent",
      "x".repeat(MAX_TYPED_PROMPT_CHARS + 1),
    );
    await recordTypedPrompt(home, "thread", "", "sent", "typed");
    expect(
      await stat(dirname(typedPromptRecordPath(home, "thread", "turn-1")!)).catch(() => null),
    ).toBeNull();
    expect(typedPromptRecordPath(home, "..", "turn-1")).toBeUndefined();
    await recordTypedPrompt(home, "..", "turn-1", "sent", "typed");
    expect(await readTypedPrompt(home, "..", "turn-1")).toBeUndefined();
  });

  test("malformed, mismatched and oversized per-turn records are ignored", async () => {
    const home = await temporaryCodexHome();
    const path = typedPromptRecordPath(home, "thread", "turn-1")!;
    await mkdir(dirname(path), { recursive: true });
    const record = { turnId: "turn-1", sent: typedPromptDigest("sent"), typed: "/template" };
    for (const invalid of [
      "not json",
      JSON.stringify({ ...record, typed: 7 }),
      JSON.stringify({ ...record, turnId: "another-turn" }),
      // Valid JSON and valid fields, but the file exceeds the read-side byte bound.
      `${JSON.stringify(record)}${" ".repeat(6 * MAX_TYPED_PROMPT_CHARS + 2_049)}`,
    ]) {
      await writeFile(path, invalid);
      expect(await readTypedPrompt(home, "thread", "turn-1")).toBeUndefined();
    }
    await writeFile(path, JSON.stringify(record));
    expect(await readTypedPrompt(home, "thread", "turn-1")).toEqual(record);
    await inheritTypedPrompts(home, "thread", "fork");
    expect(await readTypedPrompt(home, "fork", "turn-1")).toEqual(record);
  });

  test("more than 500 turns remain readable by a fresh process and a fork", async () => {
    const home = await temporaryCodexHome();
    for (let index = 0; index < 1005; index += 1) {
      await recordTypedPrompt(home, "thread", `turn-${index}`, `sent ${index}`, `/t ${index}`);
    }
    const modulePath = join(import.meta.dir, "typed-prompts.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      const { readTypedPrompt } = await import(${JSON.stringify(modulePath)});
      for (const i of [0, 500, 1004]) {
        if ((await readTypedPrompt(process.argv[1], 'thread', 'turn-' + i))?.typed !== '/t ' + i) process.exit(1);
      }
    `,
        home,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    await inheritTypedPrompts(home, "thread", "fork");
    for (const index of [0, 500, 1004]) {
      expect((await readTypedPrompt(home, "fork", `turn-${index}`))?.typed).toBe(`/t ${index}`);
    }
  }, 30_000);

  test("independent writers and pending writes across hundreds of threads retain every turn", async () => {
    const home = await temporaryCodexHome();
    // Exceeds the former journal LRU capacity while its writes are in flight.
    const pending = Array.from({ length: 300 }, (_, i) =>
      recordTypedPrompt(home, `thread-${i}`, "turn", "sent", `typed ${i}`),
    );
    const modulePath = join(import.meta.dir, "typed-prompts.ts");
    const children = [0, 1].map((writer) =>
      Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
      const { recordTypedPrompt } = await import(${JSON.stringify(modulePath)});
      for (let i = 0; i < 520; i++) await recordTypedPrompt(process.argv[1], 'shared', process.argv[2] + '-' + i, 'sent', 'typed ' + i);
    `,
          home,
          String(writer),
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const last = recordTypedPrompt(home, "thread-0", "later", "sent", "later typed");
    expect((await readTypedPrompt(home, "thread-0", "turn"))?.typed).toBe("typed 0");
    await Promise.all([...pending, last]);
    for (const child of children) expect(await child.exited).toBe(0);
    for (let writer = 0; writer < 2; writer += 1) {
      for (let i = 0; i < 520; i += 1) {
        expect((await readTypedPrompt(home, "shared", `${writer}-${i}`))?.typed).toBe(`typed ${i}`);
      }
    }
    expect((await readTypedPrompt(home, "thread-0", "later"))?.typed).toBe("later typed");
  }, 30_000);

  test("a fork waits for pending parent writes and leaves the parent intact", async () => {
    const home = await temporaryCodexHome();
    const pending = recordTypedPrompt(home, "parent", "turn", "$tidy", "/skill:tidy");
    await inheritTypedPrompts(home, "parent", "fork");
    await pending;
    expect((await readTypedPrompt(home, "fork", "turn"))?.typed).toBe("/skill:tidy");
    expect((await readTypedPrompt(home, "parent", "turn"))?.typed).toBe("/skill:tidy");
    await inheritTypedPrompts(home, "empty", "empty-fork");
    expect(
      await stat(dirname(typedPromptRecordPath(home, "empty-fork", "turn")!)).catch(() => null),
    ).toBeNull();
  });
});
