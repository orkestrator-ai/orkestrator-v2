import type { TerminalAppearance } from "@/types";

/**
 * Username for root terminal sessions inside Docker containers.
 * This user is created with UID 0 (root-equivalent) in the Dockerfile.
 * Must stay in sync with docker/Dockerfile.
 */
export const ROOT_TERMINAL_USER = "orkroot";

/** Default terminal appearance values - shared across all components */
export const TERMINAL_BACKGROUND_COLOR = "#141414";

/** Default terminal appearance values - shared across all components */
export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: "FiraCode Nerd Font",
  fontSize: 14,
  backgroundColor: TERMINAL_BACKGROUND_COLOR,
};

/**
 * Returns a safe terminal background color with fallback to defaults.
 */
export function resolveTerminalBackgroundColor(
  backgroundColor: string | undefined,
): string {
  if (!backgroundColor || !isValidHexColor(backgroundColor)) {
    return DEFAULT_TERMINAL_APPEARANCE.backgroundColor;
  }

  return backgroundColor;
}

/** Default terminal scrollback buffer (lines) */
export const DEFAULT_TERMINAL_SCROLLBACK = 1000;

/** Available font options for terminal settings */
export const FONT_OPTIONS = [
  { value: "FiraCode Nerd Font", label: "FiraCode Nerd Font (Default)" },
  { value: "Fira Code", label: "Fira Code" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "Cascadia Code", label: "Cascadia Code" },
  { value: "Source Code Pro", label: "Source Code Pro" },
  { value: "Monaco", label: "Monaco" },
  { value: "Menlo", label: "Menlo" },
  { value: "Consolas", label: "Consolas" },
  { value: "monospace", label: "System Monospace" },
] as const;

/** Regex to validate hex color format (#RGB or #RRGGBB) */
export const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;

/**
 * Validates a hex color string
 * @param color - The color string to validate
 * @returns true if the color is a valid hex format
 */
export function isValidHexColor(color: string): boolean {
  return HEX_COLOR_REGEX.test(color);
}

/**
 * Calculates relative luminance of a hex color (per WCAG 2.0)
 * @param hex - Hex color string (e.g., "#1e1e1e")
 * @returns Luminance value between 0 (black) and 1 (white)
 */
export function getLuminance(hex: string): number {
  // Remove # if present
  const color = hex.replace("#", "");

  // Handle 3-character hex
  const fullHex = color.length === 3
    ? color.split("").map(c => c + c).join("")
    : color;

  const r = parseInt(fullHex.slice(0, 2), 16) / 255;
  const g = parseInt(fullHex.slice(2, 4), 16) / 255;
  const b = parseInt(fullHex.slice(4, 6), 16) / 255;

  // Apply gamma correction
  const gammaCorrect = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * gammaCorrect(r) + 0.7152 * gammaCorrect(g) + 0.0722 * gammaCorrect(b);
}

/**
 * Determines if text should be light or dark based on background color
 * Uses WCAG 2.0 contrast ratio recommendations
 * @param backgroundColor - Hex color of the background
 * @returns true if text should be light (white), false if dark (black)
 */
export function shouldUseLightText(backgroundColor: string): boolean {
  // Default to light text if color is invalid
  if (!isValidHexColor(backgroundColor)) {
    return true;
  }
  // Luminance threshold of 0.179 is recommended for accessibility
  return getLuminance(backgroundColor) < 0.179;
}

/**
 * Gets appropriate preview text colors based on background luminance
 * @param backgroundColor - Hex color of the background
 * @returns Object with foreground and accent colors
 */
export function getPreviewColors(backgroundColor: string): {
  foreground: string;
  prompt: string;
  path: string;
} {
  const useLightText = shouldUseLightText(backgroundColor);

  return useLightText
    ? {
        foreground: "#e4e4e7",  // Light gray
        prompt: "#4ade80",      // Green
        path: "#60a5fa",        // Blue
      }
    : {
        foreground: "#1e1e1e",  // Dark gray
        prompt: "#166534",      // Dark green
        path: "#1e40af",        // Dark blue
      };
}
