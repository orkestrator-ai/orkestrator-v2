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
      "--color-background": "#0e1014",
      "--color-foreground": "#e7e9ee",
      "--color-muted": "#1c1f26",
      "--color-muted-foreground": "#8d929e",
      "--color-card": "#14161b",
      "--color-card-foreground": "#e7e9ee",
      "--color-panel-surface": "#1c1f26",
      "--color-popover": "#16181e",
      "--color-popover-foreground": "#e7e9ee",
      "--color-border": "#262a32",
      "--color-input": "#262a32",
      "--color-input-surface": "color-mix(in srgb, var(--color-zinc-900) 90%, transparent)",
      "--color-primary": "#3b82f6",
      "--color-primary-foreground": "#ffffff",
      "--color-secondary": "#23262e",
      "--color-secondary-foreground": "#e7e9ee",
      "--color-accent": "#23262e",
      "--color-accent-foreground": "#f2f4f8",
      "--color-destructive": "#e5534b",
      "--color-destructive-foreground": "#ffffff",
      "--color-ring": "#3b82f6",
      // Named shell surfaces. `elevated` in particular is the control surface
      // that survives the central panel's terminal-background override, so a
      // rename here silently flattens every button onto its own background.
      "--color-chrome": "#17191f",
      "--color-sidebar": "#101319",
      "--color-elevated": "#23262e",
      "--color-elevated-hover": "#2c303a",
      "--color-divider": "#22262d",
      "--color-selected": "#1d2941",
      "--color-selected-edge": "#141d2e",
      "--color-selected-foreground": "#e8eefb",
      "--color-hover": "#1a2438",
      // One green and one red for added/removed lines and every pass/fail
      // outcome. The green/red ramps are anchored on these at step 400, so a
      // change here has to move `--color-green-400`/`--color-red-400` with it.
      "--color-success": "#5ee39b",
      "--color-failure": "#ff7b72",
      "--color-green-400": "oklch(82.37% 0.1561 156.6)",
      "--color-red-400": "oklch(73.45% 0.1626 25.78)",
      "--color-status-running": "#5ee39b",
      "--color-status-stopped": "#71717a",
      "--color-status-error": "#ff7b72",
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

  test("shared form controls use the same raised surface as agent compose bars", () => {
    const formControlSources = [
      "apps/web/src/components/ui/input.tsx",
      "apps/web/src/components/ui/textarea.tsx",
      "apps/web/src/components/ui/select.tsx",
    ];

    for (const source of formControlSources) {
      expect(read(source)).toContain("bg-input-surface");
    }

    expect(read("apps/web/src/components/chat/NativeComposeBar.tsx")).toContain("bg-input-surface");
  });

  test("form controls use the same visible focus ring even when borders are overridden", () => {
    for (const source of [
      "apps/web/src/components/ui/input.tsx",
      "apps/web/src/components/ui/textarea.tsx",
      "apps/web/src/components/ui/select.tsx",
    ]) {
      const contents = read(source);
      expect(contents).toContain("focus-visible:border-ring");
      expect(contents).toContain("focus-visible:ring-ring/50");
      expect(contents).toContain("focus-visible:ring-[3px]");
    }

    const settings = read("apps/web/src/components/settings/GlobalSettings.sections.tsx");
    expect(settings).not.toContain("focus-visible:outline-1 focus-visible:outline-ring");
  });

  test("native scrollbar tracks inherit the panel surface", () => {
    const css = read("apps/web/src/index.css");

    expect(css).toMatch(/html\s*{[^}]*scrollbar-color:\s*var\(--color-border\)\s+transparent/s);
    expect(css).toMatch(/::-webkit-scrollbar-track\s*{[^}]*background-color:\s*transparent/s);
    expect(css).toMatch(/::-webkit-scrollbar-corner\s*{[^}]*background-color:\s*transparent/s);
    expect(css).toMatch(/::-webkit-scrollbar\s*{[^}]*width:\s*8px[^}]*height:\s*8px/s);
    expect(css).toMatch(/::-webkit-scrollbar-thumb\s*{[^}]*@apply\s+bg-border\s+rounded-md/s);
    expect(css).toMatch(/::-webkit-scrollbar-thumb:hover\s*{[^}]*@apply\s+bg-muted-foreground/s);
  });
});
