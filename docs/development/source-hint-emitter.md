# Emitting source hints from a project

Web annotations can tell an agent which file a page element probably came from,
if the page says so. Orkestrator ships no package for this. A project opts in
by adding the small Babel plugin below to its development build. A page that
emits nothing keeps working as it does today, with no hints in its notes.

The contract is in
[web-page-annotations.md](../architecture/web-page-annotations.md#development-source-hints).
The plugin below is run by
`apps/desktop/tests/source-hint-emitter-doc.test.ts`; both Vite configurations
are exercised by `source-hint-emitter-vite.integration.test.ts`. Changes to
these snippets need the normal code checks.

## What a hint is

A hint is a candidate location, never proof. The page declares it, so the
backend only checks that the path exists in the workspace at capture. It does
not check that the element came from that file, and never reads the line or the
component. The agent and the note's thread both show it as a candidate.

## The plugin

Copy this into the project. It has no dependencies beyond Babel itself.

```js
// orkestrator-source-babel-plugin.mjs
import path from "node:path";

const SOURCE = "data-orkestrator-source";
const COMPONENT = "data-orkestrator-component";

/** The workspace-relative path, or null for one the desktop capture would drop. */
function workspacePath(root, filename) {
  if (!filename) return null;
  const relative = path.relative(root, filename).split(path.sep).join("/");
  const refused =
    relative.startsWith("../") ||
    relative.includes("node_modules/") ||
    /[\\:\u0000-\u001f\u007f]/.test(relative);
  return refused ? null : relative;
}

/**
 * Stamps host JSX elements with where they were written. `root` is the
 * workspace root. Does nothing unless Babel's env is `development`.
 */
export default function orkestratorSource(api, { root = process.cwd() } = {}) {
  const t = api.types;
  if (!api.env("development")) return { name: "orkestrator-source", visitor: {} };
  return {
    name: "orkestrator-source",
    visitor: {
      JSXOpeningElement(element, state) {
        const { node } = element;
        // Host elements only: a component may not forward the attribute, and a
        // Fragment rejects it.
        if (!t.isJSXIdentifier(node.name) || !/^[a-z]/.test(node.name.name)) return;
        const file = workspacePath(root, state.filename);
        if (!file || !node.loc) return;
        const written = (attribute) => t.isJSXAttribute(attribute) && attribute.name.name === SOURCE;
        if (node.attributes.some(written)) return;
        const add = (name, value) =>
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(name),
              t.jsxExpressionContainer(t.stringLiteral(value)),
            ),
          );
        const { line, column } = node.loc.start;
        add(SOURCE, `${file}:${line}:${column + 1}`);
        const owner = element.findParent((parent) =>
          /^[A-Z]\w*[a-z]/.test(parent.node.id?.name ?? ""),
        );
        if (owner) add(COMPONENT, owner.node.id.name);
      },
    },
  };
}
```

Paths must come out relative to the workspace, the checkout root that holds
`.git`. `root` must point there, not at the package, in a monorepo.

## Adding it to the build

Add it only to the development build. Babel treats an unset `NODE_ENV` as
development, so the plugin's own check is not enough on its own.

Vite 8 with `@vitejs/plugin-react` 6, which removed its `babel` option:

```sh
npm install -D @rolldown/plugin-babel @babel/core
```

```js
// vite.config.js
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import orkestratorSource from "./orkestrator-source-babel-plugin.mjs";

// This config's directory to the workspace root; use "." outside a monorepo.
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === "serve" ? [babel({ plugins: [[orkestratorSource, { root }]] })] : []),
  ],
}));
```

Vite 7 with `@vitejs/plugin-react` 5 takes the plugin directly:

```js
// vite.legacy.config.js
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import orkestratorSource from "./orkestrator-source-babel-plugin.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react({ babel: { plugins: command === "serve" ? [[orkestratorSource, { root }]] : [] } })],
}));
```

Other Babel setups add the same plugin entry to their development configuration.
Both Vite setups above are tested with development transforms and production
builds, including a production build with `NODE_ENV=development` to check the
configuration gate independently of the plugin's gate.

## Projects without Babel

- **SWC.** A custom SWC plugin is a Rust and WebAssembly project, so there is no
  short equivalent. Next.js drops SWC entirely once a project adds a Babel
  config, which is usually too high a price for hints.
- **Other templates (Vue, Svelte, server-rendered HTML).** Any tool that writes
  the attributes works, because the capture reads only the DOM. Write
  `data-orkestrator-source="path/from/workspace.ext:line"` and optionally
  `data-orkestrator-component="Name"` in development output.

Tools that emit similar attributes under other names are not read, and their
paths are often absolute, which the capture drops.

## Optional page metadata

Both go in the page's `<head>`, in development only:

- `<meta name="orkestrator-source-producer" content="my-tool">` names the tool
  in the hint. Without it the producer is `data-orkestrator-source`.
- `<meta name="orkestrator-source-root" content="apps/web">` is for emitters
  whose paths are relative to a project directory rather than the workspace. The
  plugin above does not need it.

## Checking it works

1. Start the dev server and inspect an element: it should carry
   `data-orkestrator-source="apps/web/src/Save.tsx:12:7"`, relative to the
   workspace.
2. Build for production and confirm no paths shipped:
   `grep -r data-orkestrator-source dist` finds nothing.
3. In Orkestrator, capture the element as a note. The thread lists it under
   "Source candidates", with "path found in workspace at capture" once the
   backend has checked the path.

## Limits

- Hints come only from element captures, on the desktop app, with a backend that
  advertises `operations.sourceHints`. Text, region and page captures have none.
- A capture keeps the nearest four distinct paths among the selected element and
  up to 16 ancestors. The line comes from the element nearest the selection.
- The plugin stamps every lowercase JSX tag. A renderer whose lowercase tags are
  not DOM elements, such as React Three Fiber, needs those files left out.
- A component's own element carries the location of the JSX that wrote it, not
  of the place that used the component. Elements written by a library inside
  `node_modules` carry nothing, so the capture falls back to the nearest
  stamped ancestor.
