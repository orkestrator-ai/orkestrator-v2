/**
 * The exec-policy rules a sandbox-off read-only turn reads through. The
 * runtime side (written before the thread starts, never for other turns) is
 * in `app-server-runtime-read-only-sandbox.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS,
  CODEX_READ_ONLY_ALLOWED_PROGRAMS,
  CODEX_READ_ONLY_RULES_FILENAME,
  codexReadOnlyExecRules,
  codexReadOnlyExecRulesInstructions,
  ensureCodexReadOnlyExecRules,
} from "./codex-read-only-exec-rules.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ork-codex-rules-"));
});
afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
});

describe("read-only exec-policy rules", () => {
  // A prefix rule lets any arguments follow, so a program with any option
  // that writes a file or runs another program must never be on the list.
  test("allow no program with an option that writes a file or runs another", () => {
    for (const program of ["rg", "sed", "find", "awk", "sort", "uniq", "tree", "file"]) {
      expect(CODEX_READ_ONLY_ALLOWED_PROGRAMS).not.toContain(program);
    }
    for (const launcher of ["xargs", "env", "bash", "sh", "git", "timeout", "nice"]) {
      expect(CODEX_READ_ONLY_ALLOWED_PROGRAMS).not.toContain(launcher);
    }
    for (const sub of ["diff", "show", "log", "grep", "branch", "config", "-c", "-C"]) {
      expect(CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS).not.toContain(sub);
    }
  });

  test("are two allow rules in Codex's Starlark rule language", () => {
    const rules = codexReadOnlyExecRules();
    expect(rules.match(/prefix_rule\(/g)).toHaveLength(2);
    expect(rules.match(/decision = "allow"/g)).toHaveLength(2);
    expect(rules).not.toContain('"prompt"');
    const list = (values: readonly string[]) => JSON.stringify(values).replaceAll(",", ", ");
    expect(rules).toContain(`pattern = [${list(CODEX_READ_ONLY_ALLOWED_PROGRAMS)}],`);
    expect(rules).toContain(`pattern = ["git", ${list(CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS)}],`);
  });

  test("tell the model every allowed command", () => {
    const instructions = codexReadOnlyExecRulesInstructions();
    for (const program of CODEX_READ_ONLY_ALLOWED_PROGRAMS) expect(instructions).toContain(program);
    for (const sub of CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS) {
      expect(instructions).toContain(`git ${sub}`);
    }
  });

  test("are written into CODEX_HOME/rules, leaving no temporary file", async () => {
    await ensureCodexReadOnlyExecRules(home);
    const directory = join(home, "rules");
    expect(readdirSync(directory)).toEqual([CODEX_READ_ONLY_RULES_FILENAME]);
    expect(await readFile(join(directory, CODEX_READ_ONLY_RULES_FILENAME), "utf8")).toBe(
      codexReadOnlyExecRules(),
    );
  });

  test("are not rewritten when unchanged, and restored when edited", async () => {
    const path = join(home, "rules", CODEX_READ_ONLY_RULES_FILENAME);
    await ensureCodexReadOnlyExecRules(home);
    const written = statSync(path).ino;
    await ensureCodexReadOnlyExecRules(home);
    expect(statSync(path).ino).toBe(written);

    writeFileSync(path, 'prefix_rule(pattern = ["rm"], decision = "allow")\n');
    await ensureCodexReadOnlyExecRules(home);
    expect(await readFile(path, "utf8")).toBe(codexReadOnlyExecRules());
  });

  // Root ignores directory permissions, so the failure cannot be staged there.
  test.skipIf(process.getuid?.() === 0)(
    "a write that fails rejects and leaves no temporary file behind",
    async () => {
      chmodSync(home, 0o500);
      await expect(ensureCodexReadOnlyExecRules(home)).rejects.toThrow();
      expect(readdirSync(home)).toEqual([]);
    },
  );
});
