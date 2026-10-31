/** Execute the doc's complete configurations against real Vite/plugin versions. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { documentedSnippet } from "./source-hint-emitter-fixture";

for (const legacy of [false, true]) {
  test(`documented Vite ${legacy ? "7/plugin-react 5" : "8/plugin-react 6"} config gates emitted paths`, async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "source-hint-vite-"));
    try {
      const project = path.join(workspace, "apps/web");
      await mkdir(path.join(project, "src"), { recursive: true });
      await mkdir(path.join(workspace, "node_modules/@vitejs"), { recursive: true });
      await mkdir(path.join(workspace, "node_modules/@rolldown"), { recursive: true });
      const packages: Record<string, string> = {
        vite: legacy ? "vite-legacy" : "vite",
        "@vitejs/plugin-react": legacy ? "vite-react-legacy" : "@vitejs/plugin-react",
        "@rolldown/plugin-babel": "@rolldown/plugin-babel",
        "@babel/core": "@babel/core",
      };
      await mkdir(path.join(workspace, "node_modules/@babel"), { recursive: true });
      for (const [name, installed] of Object.entries(packages)) {
        await symlink(
          path.resolve(import.meta.dir, "../node_modules", installed),
          path.join(workspace, "node_modules", name),
        );
      }
      for (const name of ["react", "react-dom"]) {
        await symlink(
          path.resolve(import.meta.dir, "../../../node_modules", name),
          path.join(workspace, "node_modules", name),
        );
      }
      await writeFile(path.join(workspace, "package.json"), '{"type":"module"}');
      await writeFile(
        path.join(project, "orkestrator-source-babel-plugin.mjs"),
        await documentedSnippet("orkestrator-source-babel-plugin.mjs"),
      );
      await writeFile(
        path.join(project, "vite.config.js"),
        await documentedSnippet(legacy ? "vite.legacy.config.js" : "vite.config.js"),
      );
      await writeFile(
        path.join(project, "index.html"),
        '<div id="root"></div><script type="module" src="/src/Save.tsx"></script>',
      );
      await writeFile(
        path.join(project, "src/Save.tsx"),
        `import {createRoot} from "react-dom/client";
function SettingsSave() { return <button>Save</button>; }
createRoot(document.getElementById("root")!).render(<SettingsSave />);`,
      );
      await writeFile(
        path.join(workspace, "run.mjs"),
        `
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer, build } from "vite";
const root = new URL("./apps/web/", import.meta.url).pathname;
const configFile = root + "vite.config.js";
if (process.argv[2] === "serve") {
  const server = await createServer({ root, configFile, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: "error" });
  try {
    const result = await server.transformRequest("/src/Save.tsx");
    assert.match(result.code, /data-orkestrator-source/);
    assert.match(result.code, /apps\\/web\\/src\\/Save.tsx:2:/);
    assert.match(result.code, /data-orkestrator-component/);
    assert.match(result.code, /SettingsSave/);
  } finally { await server.close(); }
} else {
  await build({ root, configFile, logLevel: "error", build: { minify: false } });
  for (const name of await readdir(root + "dist/assets")) {
    const output = await readFile(root + "dist/assets/" + name, "utf8");
    assert.ok(!/data-orkestrator/.test(output), "Production output contains source stamps");
  }
}
`,
      );
      for (const [command, nodeEnv] of [
        ["serve", "development"],
        ["build", "production"],
        ["build", "development"],
      ]) {
        const child = Bun.spawn([process.execPath, path.join(workspace, "run.mjs"), command!], {
          cwd: workspace,
          env: { ...process.env, NODE_ENV: nodeEnv!, BABEL_ENV: nodeEnv! },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 25_000,
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit, `${command}/${nodeEnv}\n${stdout}\n${stderr}`).toBe(0);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);
}
