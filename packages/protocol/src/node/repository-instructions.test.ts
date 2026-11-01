import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepositoryInstructions } from "./repository-instructions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repository-instructions-"));
  roots.push(root);
  const cwd = join(root, "checkout");
  await mkdir(cwd);
  return cwd;
}

describe("readRepositoryInstructions", () => {
  test("wraps the working directory's AGENTS.md with its path", async () => {
    const cwd = await checkout();
    await writeFile(join(cwd, "AGENTS.md"), "Use tabs.\n");
    const block = await readRepositoryInstructions(cwd);
    expect(block).toStartWith("# Repository instructions (AGENTS.md)");
    expect(block).toContain(join(cwd, "AGENTS.md"));
    expect(block).toEndWith("Use tabs.");
  });

  test("is undefined without a file, or for an empty one", async () => {
    const cwd = await checkout();
    expect(await readRepositoryInstructions(cwd)).toBeUndefined();
    await writeFile(join(cwd, "AGENTS.md"), "  \n");
    expect(await readRepositoryInstructions(cwd)).toBeUndefined();
  });

  test("cuts a long file and says where the rest is", async () => {
    const cwd = await checkout();
    await writeFile(join(cwd, "AGENTS.md"), `${"a".repeat(100)}${"é".repeat(50)}`);
    const block = (await readRepositoryInstructions(cwd, 101))!;
    expect(block).toContain(`${"a".repeat(100)}\n`);
    expect(block).not.toContain("�");
    expect(block).toContain("is longer than this session can hold");
  });

  test("follows a link inside the checkout but not one that leaves it", async () => {
    const cwd = await checkout();
    await writeFile(join(cwd, "RULES.md"), "Inside.\n");
    await symlink(join(cwd, "RULES.md"), join(cwd, "AGENTS.md"));
    expect(await readRepositoryInstructions(cwd)).toContain("Inside.");

    const other = await checkout();
    const outside = join(other, "..", "secret.md");
    await writeFile(outside, "Outside.\n");
    await symlink(outside, join(other, "AGENTS.md"));
    expect(await readRepositoryInstructions(other)).toBeUndefined();
  });
});
