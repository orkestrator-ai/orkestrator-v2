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
  test("index.css declares the complete shared theme contract", () => {
    const css = read("apps/web/src/index.css");
    const expectedTokens = {
      "--color-background": "#000000",
      "--color-foreground": "#e4e4e7",
      "--color-muted": "#27272a",
      "--color-muted-foreground": "#a1a1aa",
      "--color-card": "#18181b",
      "--color-card-foreground": "#e4e4e7",
      "--color-panel-surface": "#27272a",
      "--color-popover": "#27272a",
      "--color-popover-foreground": "#e4e4e7",
      "--color-border": "#3f3f46",
      "--color-input": "#3f3f46",
      "--color-primary": "#3b82f6",
      "--color-primary-foreground": "#ffffff",
      "--color-secondary": "#3f3f46",
      "--color-secondary-foreground": "#e4e4e7",
      "--color-accent": "#3f3f46",
      "--color-accent-foreground": "#e4e4e7",
      "--color-destructive": "#ef4444",
      "--color-destructive-foreground": "#ffffff",
      "--color-ring": "#3b82f6",
      "--color-status-running": "#22c55e",
      "--color-status-stopped": "#71717a",
      "--color-status-error": "#ef4444",
      "--color-status-creating": "#3b82f6",
      "--sidebar-width": "280px",
      "--sidebar-width-collapsed": "0px",
      "--radius-lg": "0.5rem",
      "--radius-md": "0.375rem",
      "--radius-sm": "0.25rem",
    };

    for (const [name, value] of Object.entries(expectedTokens)) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

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

  test("native scrollbars use the dark surface palette", () => {
    const css = read("apps/web/src/index.css");

    expect(css).toMatch(
      /html\s*{[^}]*scrollbar-color:\s*var\(--color-border\)\s+var\(--color-background\)/s,
    );
    expect(css).toMatch(/::-webkit-scrollbar-track\s*{[^}]*@apply\s+bg-background/s);
    expect(css).toMatch(/::-webkit-scrollbar\s*{[^}]*width:\s*8px[^}]*height:\s*8px/s);
    expect(css).toMatch(/::-webkit-scrollbar-thumb\s*{[^}]*@apply\s+bg-border\s+rounded-md/s);
    expect(css).toMatch(/::-webkit-scrollbar-thumb:hover\s*{[^}]*@apply\s+bg-muted-foreground/s);
  });
});
