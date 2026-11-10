import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanDomAbsenceAssertions } from "../dom-absence-scan";
import { RepositoryIndex } from "../source-guards/repository-index";

// The scan of the real repository runs in the guard stage (`mise run guards`,
// scripts/guards.ts), once, with the other repository-wide guards.
describe("bounded test diagnostics", () => {
  test("scans nested repository tests while excluding dependencies and generated copies", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dom-absence-scan-"));
    try {
      const files = [
        "tests/nested/unsafe.test.ts",
        "apps/web/src/unsafe.spec.tsx",
        "bridges/example/src/unsafe.test.mjs",
        "apps/web/node_modules/dependency/unsafe.test.ts",
        "bridges/example/dist/unsafe.test.ts",
        "tests/.git/unsafe.test.ts",
        "tests/helper.ts",
        "docs/unsafe.test.ts",
      ];
      for (const file of files) {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "expect(container.querySelector('.spinner')).toBeNull();");
      }
      symlinkSync(path.join(root, "tests/nested"), path.join(root, "apps/linked-tests"), "dir");
      const scan = () => scanDomAbsenceAssertions(RepositoryIndex.fromWalk(root));
      expect(scan()).toEqual(files.slice(0, 3).sort());
      // A listed file that is gone from the working tree is skipped, not an error.
      const listed = RepositoryIndex.fromWalk(root);
      rmSync(path.join(root, files[1]!));
      expect(scanDomAbsenceAssertions(listed)).toEqual([files[0]!, files[2]!].sort());
      writeFileSync(path.join(root, files[1]!), "expect(a).toBeNull();");
      // A candidate that does not parse fails the scan instead of passing.
      writeFileSync(path.join(root, files[0]!), "const broken = ; expect(a).toBeNull();");
      expect(scan).toThrow("unsafe.test.ts:");
      // A file that cannot hold a toBeNull call is not parsed at all.
      writeFileSync(path.join(root, files[0]!), "const broken = ;");
      expect(scan()).toEqual([files[2]!]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
