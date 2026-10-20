import type { HighlightLanguage } from "./languages";

/** Version of the highlighter output; part of every highlight cache key. */
export const HIGHLIGHTER_VERSION = "shiki-4.5.0:github:v1";

export type HighlightTheme = "dark" | "light";

/** One token: content, optional colour, optional Shiki font-style bit set. */
export interface HighlightToken {
  c: string;
  s?: string;
  f?: number;
}

export type HighlightLine = HighlightToken[];

export interface HighlightRequest {
  id: number;
  lang: HighlightLanguage;
  theme: HighlightTheme;
  /** Complete lines only, `\n`-separated, no trailing newline. */
  code: string;
  /** Continue from a grammar state the worker returned for the previous lines. */
  resumeStateId?: string;
}

export type HighlightResponse =
  | { id: number; ok: true; lines: HighlightLine[]; stateId: string | null }
  | { id: number; ok: false; error: "state-missing" | "unsupported" | "failed" };

/** Shiki `FontStyle` bits. */
export const FONT_STYLE = { italic: 1, bold: 2, underline: 4, strikethrough: 8 } as const;
