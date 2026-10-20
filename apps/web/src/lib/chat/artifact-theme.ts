import { useSyncExternalStore } from "react";

/**
 * Presentation theme for rich transcript content: the application's current
 * appearance, reduced-motion preference and the approved CSS custom
 * properties an interactive artifact frame may receive.
 *
 * Theme data is presentation only. Sending it to a frame never claims the
 * artifact was verified under that theme; receipts name their own profile.
 */

export type AppAppearance = "light" | "dark";

export function currentAppAppearance(): AppAppearance {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function subscribeAppearance(listener: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** The app appearance, re-read when the root `dark` class changes. */
export function useAppAppearance(): AppAppearance {
  return useSyncExternalStore(subscribeAppearance, currentAppAppearance, () => "dark");
}

/**
 * Application theme tokens offered to artifact frames, renamed into an
 * `--ork-*` namespace so authored CSS cannot depend on internal names.
 */
export const ARTIFACT_THEME_TOKEN_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "--ork-background": "--color-background",
  "--ork-foreground": "--color-foreground",
  "--ork-muted": "--color-muted",
  "--ork-muted-foreground": "--color-muted-foreground",
  "--ork-card": "--color-card",
  "--ork-card-foreground": "--color-card-foreground",
  "--ork-border": "--color-border",
  "--ork-primary": "--color-primary",
  "--ork-primary-foreground": "--color-primary-foreground",
  "--ork-accent": "--color-accent",
  "--ork-accent-foreground": "--color-accent-foreground",
  "--ork-destructive": "--color-destructive",
  "--ork-success": "--color-success",
  "--ork-ring": "--color-ring",
});

/** Values must be plain colour/length text: no functions that fetch, no rule breaks. */
const SAFE_TOKEN_VALUE = /^[A-Za-z0-9#%.,\s()+\-/]*$/;

export function sanitizeArtifactThemeTokenValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length >= 200) return null;
  if (!SAFE_TOKEN_VALUE.test(trimmed)) return null;
  if (/url\s*\(|image\s*\(|image-set|expression|@import/i.test(trimmed)) return null;
  return trimmed;
}

export function readArtifactThemeTokens(
  read: (property: string) => string = (property) =>
    typeof window === "undefined"
      ? ""
      : window.getComputedStyle(document.documentElement).getPropertyValue(property),
): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [name, source] of Object.entries(ARTIFACT_THEME_TOKEN_SOURCES)) {
    const value = sanitizeArtifactThemeTokenValue(read(source));
    if (value) tokens[name] = value;
  }
  tokens["--ork-font-sans"] = "system-ui, -apple-system, Segoe UI, sans-serif";
  return tokens;
}
