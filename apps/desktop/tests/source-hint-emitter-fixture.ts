/** Build the desktop fixture's Save button with the exact documented emitter. */
import { transformAsync } from "@babel/core";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export const EMITTER_DOC = path.resolve(
  import.meta.dir,
  "../../../docs/development/source-hint-emitter.md",
);

export async function documentedSnippet(filename: string): Promise<string> {
  const doc = await readFile(EMITTER_DOC, "utf8");
  const fence = [...doc.matchAll(/```js\n([\s\S]*?)```/g)].find((match) =>
    match[1]!.startsWith(`// ${filename}\n`),
  );
  if (!fence) throw new Error(`Missing documented snippet: ${filename}`);
  return fence[1]!;
}

if (import.meta.main) {
  const workspace = process.argv[2]!;
  const pluginFile = path.join(workspace, "orkestrator-source-babel-plugin.mjs");
  await writeFile(pluginFile, await documentedSnippet("orkestrator-source-babel-plugin.mjs"));
  const source = `function SettingsSave() {
  return <button type="submit" data-testid="save-settings">Save</button>;
}`;
  const filename = path.join(workspace, "annotation-app/GeneratedSave.tsx");
  await writeFile(filename, source);
  const result = await transformAsync(source, {
    filename,
    babelrc: false,
    configFile: false,
    envName: "development",
    parserOpts: { plugins: ["jsx"] },
    plugins: [[pluginFile, { root: workspace }]],
  });
  const transpiler = new Bun.Transpiler({
    loader: "tsx",
    tsconfig: {
      compilerOptions: { jsx: "react", jsxFactory: "h" },
    },
  });
  const load = new Function(
    "h",
    `${transpiler.transformSync(result!.code!)}\nreturn SettingsSave;`,
  );
  const html = renderToStaticMarkup(createElement(load(createElement)));
  const pageFile = path.join(workspace, "annotation-app/page.ts");
  const page = await readFile(pageFile, "utf8");
  const updated = page
    .replace('<meta name="orkestrator-source-root" content="annotation-app">', "")
    .replace(
      'data-orkestrator-source="MissingSettings.tsx:4"',
      'data-orkestrator-source="annotation-app/MissingSettings.tsx:4"',
    )
    .replace(/    <button type="submit"[^\n]+<\/button>/, `    ${html}`);
  if (updated === page || !updated.includes(html))
    throw new Error("Could not install emitted button");
  await writeFile(pageFile, updated);
}
