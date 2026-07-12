import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

// Guards the forced-dark-mode contrast fix. The app has no light theme and no
// runtime theme toggle, so these three pieces must stay in lockstep:
//   1. <html class="dark"> makes the class-based `dark` variant always active.
//   2. The class-based `@custom-variant dark` makes Tailwind v4 `dark:`
//      utilities resolve against `.dark` instead of prefers-color-scheme.
//   3. color-scheme: dark tells the browser UA to render form controls/
//      scrollbars in dark mode.
// If any one is dropped, `dark:` overrides silently stop applying while the
// dark @theme colors remain, reproducing the original low-contrast bug.
describe("forced dark mode theming", () => {
  test("index.html marks the document as dark", () => {
    const html = read("apps/web/index.html");

    // <html ... class="dark" ...> — order/other attrs are irrelevant.
    expect(html).toMatch(/<html\b[^>]*\bclass=("|')[^"']*\bdark\b[^"']*\1/);
  });

  test("index.html declares a dark color-scheme meta", () => {
    const html = read("apps/web/index.html");

    expect(html).toMatch(
      /<meta\b[^>]*\bname=("|')color-scheme\1[^>]*\bcontent=("|')[^"']*\bdark\b[^"']*\2/,
    );
  });

  test("index.css registers a class-based dark custom variant", () => {
    const css = read("apps/web/src/index.css");

    // Tailwind v4 selector-based dark variant keyed off the `.dark` class.
    // Whitespace inside the parens may vary; the `.dark` selector must remain.
    expect(css).toMatch(/@custom-variant\s+dark\s*\([^)]*\.dark[^)]*\)/);
  });

  test("index.css keeps a dark color-scheme on the html element", () => {
    const css = read("apps/web/src/index.css");

    expect(css).toMatch(/color-scheme:\s*dark/);
  });
});
