/**
 * App modules that specs drive directly inside the page, through
 * `window.__fixtureModules`. A spec could once `import("/@fs/…/src/x.ts")`, but
 * only Vite's dev server answers such a path; the suite serves a build
 * (`apps/web/vite.fixture.config.ts`). Each entry is part of the fixture's own
 * module graph, so it resolves to the same instance the page already uses,
 * with either server: a spec that patches `portalStore` patches the store the
 * dialog reads.
 *
 * The imports are lazy, so a page loads a module only when a spec asks for it.
 */
export const fixtureModules = {
  "components/html/html-preview-document": () =>
    import("../../apps/web/src/components/html/html-preview-document"),
  "lib/chat/svg-sanitize": () => import("../../apps/web/src/lib/chat/svg-sanitize"),
  "lib/monaco-dotenv": () => import("../../apps/web/src/lib/monaco-dotenv"),
  "lib/portal/portal-store": () => import("../../apps/web/src/lib/portal/portal-store"),
  "lib/stable-host": () => import("../../apps/web/src/lib/stable-host"),
  "lib/terminal-osc52": () => import("../../apps/web/src/lib/terminal-osc52"),
  "lib/terminal-xterm": () => import("../../apps/web/src/lib/terminal-xterm"),
  // The editor's own instance, so its models are the page's.
  "monaco-editor": async () =>
    (await import("../../apps/web/src/test/monaco-module")).loadMonacoEditor(),
} as const;

declare global {
  interface Window {
    __fixtureModules?: typeof fixtureModules;
  }
}

export function installFixtureModules(): void {
  window.__fixtureModules = fixtureModules;
}
