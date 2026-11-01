import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotFixtureFiles } from "../../e2e/agent-testing/codex-fixture-files";

for (const fails of [false, true]) {
  for (const existing of [false, true]) {
    test(`restores fixture bytes: failure=${fails}, existing=${existing}`, () => {
      const home = mkdtempSync(path.join(tmpdir(), "codex-fixture-"));
      const files = [path.join(home, "config.toml"), path.join(home, "rules/default.rules")];
      try {
        mkdirSync(path.join(home, "rules"));
        const original = Buffer.from("original\r\n# exact bytes\n");
        if (existing) for (const file of files) writeFileSync(file, original);
        const restore = snapshotFixtureFiles(files);
        const run = () => {
          try {
            for (const file of files) writeFileSync(file, "temporary loopback or rule");
            if (fails) throw new Error("forced scenario failure");
          } finally {
            restore();
          }
        };
        if (fails) expect(run).toThrow("forced scenario failure");
        else run();
        for (const file of files) {
          if (existing) expect(readFileSync(file)).toEqual(original);
          else expect(existsSync(file)).toBe(false);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
