/**
 * Runs the reference emitter exactly as `docs/development/source-hint-emitter.md`
 * prints it: real Babel, a real React render, then the real capture kit. The doc
 * is the only copy, so a broken snippet fails here rather than in a user's build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { transformAsync } from "@babel/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement, Fragment, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WEB_ANNOTATION_SOURCE_ATTRIBUTES } from "@orkestrator/protocol/web-annotations";
import { parseSourceHints } from "../electron/browser-preview-capture-parse";
import { click, page, type Json } from "./browser-preview-page-harness";

const DOC_PATH = path.resolve(import.meta.dir, "../../../docs/development/source-hint-emitter.md");
const PLUGIN_FENCE = /```js\n(\/\/ orkestrator-source-babel-plugin\.mjs\n[\s\S]*?)```/;
const WORKSPACE = "/workspace-root";

const transpiler = new Bun.Transpiler({
  loader: "tsx",
  deadCodeElimination: false,
  tsconfig: {
    compilerOptions: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Frag" },
  },
});

let snippet = "";
let pluginFile = "";
let directory = "";

beforeAll(async () => {
  const match = PLUGIN_FENCE.exec(await readFile(DOC_PATH, "utf8"));
  if (!match) throw new Error("The doc no longer prints the plugin fence");
  snippet = match[1]!;
  directory = await mkdtemp(path.join(os.tmpdir(), "source-hint-emitter-"));
  pluginFile = path.join(directory, "orkestrator-source-babel-plugin.mjs");
  await writeFile(pluginFile, snippet);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function emit(
  source: string,
  file: string,
  { envName = "development", root = WORKSPACE } = {},
): Promise<string> {
  const result = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    envName,
    filename: path.join(WORKSPACE, file),
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [[pluginFile, { root }]],
  });
  return result!.code!;
}

/** Evaluates emitted module text and returns its `App`; `scope` stands in for imports. */
function component(code: string, scope: Record<string, unknown> = {}): ComponentType {
  const names = Object.keys(scope);
  const load = new Function(
    "h",
    "Frag",
    ...names,
    `${transpiler.transformSync(code)}\nreturn App;`,
  ) as (...args: unknown[]) => ComponentType;
  return load(createElement, Fragment, ...names.map((name) => scope[name]));
}

function capture(html: string, selector: string): Json {
  const harness = page(html);
  harness.start("element");
  click(harness, harness.document.querySelector(selector)!);
  const status = harness.status();
  expect(status.status).toBe("selected");
  return status.selection.evidence;
}

describe("documented source hint emitter", () => {
  test("writes the protocol's attribute names", () => {
    expect(snippet).toContain(`"${WEB_ANNOTATION_SOURCE_ATTRIBUTES.path}"`);
    expect(snippet).toContain(`"${WEB_ANNOTATION_SOURCE_ATTRIBUTES.component}"`);
  });

  test("a rendered page gives the capture nearest-first candidates across files", async () => {
    const SaveButton = component(
      await emit(
        `const SaveButton = ({ label }: { label?: string }) => {
  return <button id="save">{label ?? "Save"}</button>;
};
const App = SaveButton;`,
        "apps/web/src/SaveButton.tsx",
      ),
    );
    const Settings = component(
      await emit(
        `function Settings() {
  return (
    <section>
      <div>
        <SaveButton />
      </div>
    </section>
  );
}
const App = Settings;`,
        "apps/web/src/Settings.tsx",
      ),
      { SaveButton },
    );

    const evidence = capture(renderToStaticMarkup(createElement(Settings)), "#save");

    const candidates = [
      {
        producer: "data-orkestrator-source",
        path: "apps/web/src/SaveButton.tsx",
        line: 2,
        component: "SaveButton",
        verified: false,
      },
      // The div's nearer Settings.tsx hint wins over the section's.
      {
        producer: "data-orkestrator-source",
        path: "apps/web/src/Settings.tsx",
        line: 4,
        component: "Settings",
        verified: false,
      },
    ];
    expect(evidence.sourceHints).toEqual(candidates);
    // What main keeps after revalidating the untrusted page output.
    expect(parseSourceHints(evidence.sourceHints)).toEqual(candidates);
    // The stamps do not leak into the page evidence the agent also reads.
    expect(evidence.attributes).toEqual({ id: "save" });
  });

  test("leaves components, fragments and member tags alone", async () => {
    const received: Array<Record<string, unknown>> = [];
    const Box = (props: Record<string, unknown>) => {
      received.push(props);
      return null;
    };
    const App = component(
      await emit(
        `const App = () => (
  <Frag>
    <Box />
    <ui.Box />
  </Frag>
);`,
        "src/App.tsx",
      ),
      { Box, ui: { Box } },
    );
    expect(renderToStaticMarkup(createElement(App))).toBe("");
    expect(received).toEqual([{}, {}]);
  });

  test("keeps an attribute the author wrote and overrides one arriving through a spread", async () => {
    const App = component(
      await emit(
        `const rest = { "data-orkestrator-source": "src/Other.tsx:1" };
const App = () => (
  <main>
    <i data-orkestrator-source="src/Kept.tsx:9" />
    <b {...rest} />
  </main>
);`,
        "src/App.tsx",
      ),
    );
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('<i data-orkestrator-source="src/Kept.tsx:9"');
    expect(html).toContain('<b data-orkestrator-source="src/App.tsx:5:5"');
  });

  test("a path with JSX or HTML metacharacters reaches the capture intact", async () => {
    const App = component(
      await emit(`const App = () => <button id="save">Save</button>;`, 'src/[id]/(a&b)"c.tsx'),
    );
    const hints = capture(renderToStaticMarkup(createElement(App)), "#save").sourceHints;
    expect(hints[0].path).toBe('src/[id]/(a&b)"c.tsx');
  });

  test("emits nothing outside development", async () => {
    const source = `const App = () => <div />;`;
    for (const envName of ["production", "test", "staging"]) {
      expect(await emit(source, "src/App.tsx", { envName })).not.toContain("data-orkestrator");
    }
    expect(await emit(source, "src/App.tsx")).toContain("data-orkestrator-source");
  });

  test("refuses paths the desktop capture would drop", async () => {
    const source = `const App = () => <div />;`;
    const cases: Array<[string, { root: string }]> = [
      ["outside/App.tsx", { root: path.join(WORKSPACE, "project") }],
      ["node_modules/library/App.tsx", { root: WORKSPACE }],
      ["src/with:colon.tsx", { root: WORKSPACE }],
      ["src/back\\slash.tsx", { root: WORKSPACE }],
    ];
    for (const [file, options] of cases) {
      expect(await emit(source, file, options)).not.toContain("data-orkestrator");
    }
  });

  test("a page built without the emitter gives no hints", () => {
    expect(capture(`<button id="save">Save</button>`, "#save").sourceHints).toBeUndefined();
  });
});
