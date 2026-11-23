/**
 * The `monaco-editor` module the editor itself uses (`lib/monaco-loader.ts`
 * imports the same specifier), for browser specs that drive it directly
 * (`e2e/fixture/fixture-modules.ts`). It lives here because `monaco-editor` is
 * a dependency of this package, not of `e2e/`.
 */
export const loadMonacoEditor = () => import("monaco-editor");
