/**
 * The fixed set of grammars transcript code blocks may highlight, and the
 * fence aliases that select them. Anything else renders as plain text: a
 * message can never name a grammar, theme, URL or worker script to load.
 */

export const HIGHLIGHT_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "python",
  "rust",
  "go",
  "java",
  "sql",
  "shellscript",
  "yaml",
  "toml",
  "css",
  "html",
  "markdown",
  "diff",
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

const ALIASES: Record<string, HighlightLanguage> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  jsonl: "json",
  py: "python",
  python: "python",
  python3: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  java: "java",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  console: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  htm: "html",
  xhtml: "html",
  svg: "html",
  xml: "html",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

export function resolveHighlightLanguage(
  language: string | null | undefined,
): HighlightLanguage | null {
  if (!language) return null;
  return ALIASES[language.toLowerCase()] ?? null;
}

const LABELS: Partial<Record<string, string>> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSONC",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  go: "Go",
  java: "Java",
  sql: "SQL",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  shell: "Shell",
  console: "Console",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  css: "CSS",
  html: "HTML",
  svg: "SVG",
  xml: "XML",
  md: "Markdown",
  markdown: "Markdown",
  diff: "Diff",
  patch: "Patch",
  mermaid: "Mermaid",
  chart: "Chart",
};

/** A readable label for a fence language; unknown identifiers are shown as written. */
export function languageLabel(language: string | null | undefined): string {
  if (!language) return "Text";
  return LABELS[language] ?? language;
}

/** Shell fences eligible for the explicit Run in terminal action. */
export const SHELL_FENCE_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console"]);
