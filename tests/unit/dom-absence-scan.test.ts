import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanDomAbsenceAssertions } from "../dom-absence-scan";

describe("bounded test diagnostics", () => {
  test("never passes a DOM-producing query result directly to toBeNull", () => {
    expect(scanDomAbsenceAssertions(path.resolve(import.meta.dir, "../.."))).toEqual([]);
  }, 30_000);

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
      ];
      for (const file of files) {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "expect(container.querySelector('.spinner')).toBeNull();");
      }
      symlinkSync(path.join(root, "tests/nested"), path.join(root, "apps/linked-tests"), "dir");
      expect(scanDomAbsenceAssertions(root)).toEqual(files.slice(0, 3).sort());
      writeFileSync(path.join(root, files[0]!), "const broken = ;");
      expect(() => scanDomAbsenceAssertions(root)).toThrow("unsafe.test.ts:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
