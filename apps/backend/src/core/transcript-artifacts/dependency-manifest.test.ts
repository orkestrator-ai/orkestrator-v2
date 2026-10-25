import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ALL_PINNED_BUNDLES,
  pinnedLicensePath,
  writePinnedBundleLicenses,
} from "./dependency-manifest.js";

describe("pinned bundle licenses", () => {
  test("every pinned bundle ships its license texts and a combined notice", async () => {
    const target = mkdtempSync(path.join(tmpdir(), "ork-bundle-licenses-"));
    try {
      const written = await writePinnedBundleLicenses(target);
      const notices = readFileSync(path.join(target, "THIRD_PARTY_NOTICES.txt"), "utf8");
      expect(ALL_PINNED_BUNDLES.map((bundle) => bundle.id).sort()).toEqual([
        "chart.js@4.5.1",
        "d3@7.9.0",
        "dompurify@3.4.17",
        "mermaid@12.2.0",
        "pdfjs-dist-worker@6.4.299",
        "pdfjs-dist@6.4.299",
      ]);
      for (const bundle of ALL_PINNED_BUNDLES) {
        expect(bundle.licenseFiles.length).toBeGreaterThan(0);
        expect(notices).toContain(bundle.notice);
        expect(notices).toContain(bundle.sha256);
        for (const name of bundle.licenseFiles) {
          const file = pinnedLicensePath(target, bundle, name);
          expect(written).toContain(file);
          expect(readFileSync(file, "utf8").length).toBeGreaterThan(200);
        }
      }
      expect(notices).toContain("Mike Bostock");
      expect(notices).toContain("Chart.js Contributors");
      // Chart.js's UMD bundle embeds @kurkle/color; its license ships beside Chart.js's.
      expect(notices).toContain("Jukka Kurkela");
      expect(
        readFileSync(
          path.join(target, "licenses", "chart.js@4.5.1", "@kurkle", "color", "LICENSE.md"),
          "utf8",
        ),
      ).toContain("Jukka Kurkela");
      expect(notices).toContain("Knut Sveidqvist");
      expect(notices).toContain("Apache License");
      expect(notices).toContain("Mozilla Public License");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
