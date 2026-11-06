/**
 * A Vite 8 / plugin-react 6 app built exactly as source-hint-emitter.md says,
 * for the Electron spec's real dev-server capture.
 *
 *   bun source-hint-emitter-vite-app.ts write <workspace>   the committed app
 *   bun source-hint-emitter-vite-app.ts link <workspace>    its node_modules
 *
 * `write` adds `annotation-vite/` (sources, the documented plugin and config,
 * and a .gitignore for node_modules). `link` points its `node_modules` at this
 * repository's installed packages, the same ones the Vite integration test
 * uses, so a checkout needs no install; run it in each working copy that
 * serves the app. The dev server is the real Vite CLI started in
 * `annotation-vite/web` (see VITE_APP below).
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { documentedSnippet } from "./source-hint-emitter-fixture";

export const VITE_APP = {
  /** The project directory, two levels below the workspace as the documented config expects. */
  directory: "annotation-vite/web",
  /** Where Vite's CLI lives; started with `--config vite.config.js` in `directory`. */
  cli: path.resolve(import.meta.dirname, "../node_modules/vite/bin/vite.js"),
  selector: '[data-testid="vite-save"]',
  /** The element's own JSX location, then its stamped ancestor's (another file). */
  candidates: [
    {
      producer: "data-orkestrator-source",
      path: "annotation-vite/web/src/ViteSave.tsx",
      line: 2,
      component: "ViteSave",
    },
    {
      producer: "data-orkestrator-source",
      path: "annotation-vite/web/src/ViteLayout.tsx",
      line: 5,
      component: "ViteLayout",
    },
  ],
} as const;

const FILES: Record<string, string> = {
  "annotation-vite/package.json": '{ "private": true, "type": "module" }\n',
  "annotation-vite/.gitignore": "node_modules/\n",
  "annotation-vite/web/index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Vite source hints</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`,
  "annotation-vite/web/src/ViteSave.tsx": `export function ViteSave() {
  return <button type="button" data-testid="vite-save" style={{ padding: "12px 24px" }}>Save from Vite</button>;
}
`,
  "annotation-vite/web/src/ViteLayout.tsx": `import { ViteSave } from "./ViteSave";

export function ViteLayout() {
  return (
    <section data-testid="vite-layout" style={{ padding: 48 }}>
      <h1>Settings served by Vite</h1>
      <ViteSave />
    </section>
  );
}
`,
  "annotation-vite/web/src/main.tsx": `import { createRoot } from "react-dom/client";
import { ViteLayout } from "./ViteLayout";

createRoot(document.getElementById("root")!).render(<ViteLayout />);
`,
};

/** Package name to the installed directory it resolves to (as the integration test links them). */
const PACKAGES: Record<string, string> = {
  vite: path.resolve(import.meta.dirname, "../node_modules/vite"),
  "@vitejs/plugin-react": path.resolve(import.meta.dirname, "../node_modules/@vitejs/plugin-react"),
  "@rolldown/plugin-babel": path.resolve(
    import.meta.dirname,
    "../node_modules/@rolldown/plugin-babel",
  ),
  "@babel/core": path.resolve(import.meta.dirname, "../node_modules/@babel/core"),
  react: path.resolve(import.meta.dirname, "../../../node_modules/react"),
  "react-dom": path.resolve(import.meta.dirname, "../../../node_modules/react-dom"),
};

export async function writeViteApp(workspace: string): Promise<void> {
  for (const [relative, contents] of Object.entries(FILES)) {
    const file = path.join(workspace, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const project = path.join(workspace, VITE_APP.directory);
  for (const name of ["orkestrator-source-babel-plugin.mjs", "vite.config.js"])
    await writeFile(path.join(project, name), await documentedSnippet(name));
}

export async function linkViteApp(workspace: string): Promise<void> {
  const modules = path.join(workspace, "annotation-vite", "node_modules");
  for (const [name, installed] of Object.entries(PACKAGES)) {
    const link = path.join(modules, name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(installed, link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}

if (import.meta.main) {
  const [command, workspace] = process.argv.slice(2);
  if (!workspace || (command !== "write" && command !== "link"))
    throw new Error("usage: source-hint-emitter-vite-app.ts write|link <workspace>");
  await (command === "write" ? writeViteApp(workspace) : linkViteApp(workspace));
}
