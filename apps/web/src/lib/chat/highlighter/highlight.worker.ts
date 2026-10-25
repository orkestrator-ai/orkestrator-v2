/**
 * Syntax-highlighting worker: Shiki core with the Oniguruma engine and a
 * fine-grained, lazily loaded grammar set.
 *
 * Grammars, themes and the WASM engine are application build assets selected
 * from a fixed table; a request can only name one of those table keys, never a
 * URL, grammar or script. Tokenization runs here so a large fence cannot block
 * the transcript's main thread. Grammar states for incremental (streaming)
 * highlighting are kept in a small LRU and referenced by id.
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { HighlightLanguage } from "./languages";
import type {
  HighlightLine,
  HighlightRequest,
  HighlightResponse,
  HighlightTheme,
} from "./protocol";

const LANGUAGE_MODULES: Record<HighlightLanguage, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  sql: () => import("@shikijs/langs/sql"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  diff: () => import("@shikijs/langs/diff"),
};

const THEME_MODULES: Record<HighlightTheme, { name: string; load: () => Promise<unknown> }> = {
  dark: { name: "github-dark", load: () => import("@shikijs/themes/github-dark") },
  light: { name: "github-light", load: () => import("@shikijs/themes/github-light") },
};

const MAX_RETAINED_STATES = 64;

let highlighter: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<HighlightLanguage, Promise<void>>();
const loadedThemes = new Map<HighlightTheme, Promise<void>>();
const grammarStates = new Map<string, unknown>();
let nextStateId = 1;

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighter;
}

async function ensureLanguage(instance: HighlighterCore, lang: HighlightLanguage): Promise<void> {
  let loading = loadedLanguages.get(lang);
  if (!loading) {
    loading = LANGUAGE_MODULES[lang]().then((module) =>
      instance.loadLanguage(module as Parameters<HighlighterCore["loadLanguage"]>[0]),
    );
    loadedLanguages.set(lang, loading);
    // A failed load may be retried by a later request.
    loading.catch(() => loadedLanguages.delete(lang));
  }
  await loading;
}

async function ensureTheme(instance: HighlighterCore, theme: HighlightTheme): Promise<void> {
  let loading = loadedThemes.get(theme);
  if (!loading) {
    loading = THEME_MODULES[theme]
      .load()
      .then((module) => instance.loadTheme(module as Parameters<HighlighterCore["loadTheme"]>[0]));
    loadedThemes.set(theme, loading);
    loading.catch(() => loadedThemes.delete(theme));
  }
  await loading;
}

function retainState(state: unknown): string | null {
  if (!state) return null;
  const id = String(nextStateId++);
  grammarStates.set(id, state);
  while (grammarStates.size > MAX_RETAINED_STATES) {
    const oldest = grammarStates.keys().next();
    if (oldest.done) break;
    grammarStates.delete(oldest.value);
  }
  return id;
}

async function highlight(request: HighlightRequest): Promise<HighlightResponse> {
  if (!(request.lang in LANGUAGE_MODULES) || !(request.theme in THEME_MODULES)) {
    return { id: request.id, ok: false, error: "unsupported" };
  }
  let grammarState: unknown;
  if (request.resumeStateId) {
    grammarState = grammarStates.get(request.resumeStateId);
    if (!grammarState) return { id: request.id, ok: false, error: "state-missing" };
  }
  const instance = await core();
  await Promise.all([ensureLanguage(instance, request.lang), ensureTheme(instance, request.theme)]);
  const result = instance.codeToTokens(request.code, {
    lang: request.lang,
    theme: THEME_MODULES[request.theme].name,
    ...(grammarState ? { grammarState: grammarState as never } : {}),
  });
  const lines: HighlightLine[] = result.tokens.map((line) =>
    line.map((token) => ({
      c: token.content,
      ...(token.color ? { s: token.color } : {}),
      ...(token.fontStyle ? { f: token.fontStyle } : {}),
    })),
  );
  return { id: request.id, ok: true, lines, stateId: retainState(result.grammarState) };
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage: (message: HighlightResponse) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  highlight(request).then(
    (response) => scope.postMessage(response),
    () => scope.postMessage({ id: request.id, ok: false, error: "failed" }),
  );
};
