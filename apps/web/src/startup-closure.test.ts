import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SOURCE_ROOT = import.meta.dir;
// `main.tsx` loads `renderer-entry.tsx` unconditionally, so that import is part of startup too.
const ENTRIES = ["main.tsx", "renderer-entry.tsx"];
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Each must load on demand; one static import from the startup graph puts it back in the bundle. */
const ON_DEMAND_MODULES = [
  "components/chat/MessageMarkdown.tsx",
  "components/chat/NativeMessage.tsx",
  "components/chat/native-message-search.ts",
  "components/native-agent/AgentNativeTab.tsx",
  "components/projects/ProjectWorkspace.tsx",
  "components/pull-requests/PullRequestView.tsx",
  "components/terminal/PersistentTerminal.tsx",
  "lib/terminal-xterm.ts",
];
const ON_DEMAND_PACKAGES = ["@xterm/", "dompurify", "marked", "react-markdown", "react-virtuoso"];

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

function resolveSource(specifier: string, importer: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SOURCE_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(importer), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => base + extension),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, "index" + extension)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Statically reachable modules and packages, each with the import that first reached it. */
function startupGraph(): { importedBy: Map<string, string | null>; packages: Map<string, string> } {
  const importedBy = new Map<string, string | null>();
  const packages = new Map<string, string>();
  const queue = ENTRIES.map((entry) => join(SOURCE_ROOT, entry));
  for (const entry of queue) importedBy.set(entry, null);
  for (const file of queue) {
    if (!SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    // `scan` drops type-only imports, as the bundler does; dynamic imports are a separate kind.
    const transpiler = file.endsWith(".tsx") ? tsxTranspiler : tsTranspiler;
    const imports = transpiler.scan(readFileSync(file, "utf8")).imports;
    for (const { path, kind } of imports) {
      if (kind !== "import-statement") continue;
      const target = resolveSource(path, file);
      if (target) {
        if (!importedBy.has(target)) {
          importedBy.set(target, file);
          queue.push(target);
        }
      } else if (!path.startsWith(".") && !path.startsWith("@/") && !packages.has(path)) {
        packages.set(path, file);
      }
    }
  }
  return { importedBy, packages };
}

function importChain(importedBy: Map<string, string | null>, file: string): string {
  const chain: string[] = [];
  for (let current: string | null | undefined = file; current; current = importedBy.get(current)) {
    chain.unshift(relative(SOURCE_ROOT, current));
  }
  return chain.join(" -> ");
}

describe("renderer startup closure (WEB-9)", () => {
  const { importedBy, packages } = startupGraph();

  test("walks the real startup graph", () => {
    expect(importedBy.size).toBeGreaterThan(500);
    expect(importedBy.has(join(SOURCE_ROOT, "components/layout/AppShell.tsx"))).toBe(true);
    expect(packages.has("react-dom/client")).toBe(true);
  });

  test("keeps on-demand modules out of the startup graph", () => {
    const reached = ON_DEMAND_MODULES.map((module) => join(SOURCE_ROOT, module))
      .filter((file) => importedBy.has(file))
      .map((file) => importChain(importedBy, file));
    expect(reached).toEqual([]);
  });

  test("keeps on-demand packages out of the startup graph", () => {
    const reached = [...packages]
      .filter(([name]) =>
        ON_DEMAND_PACKAGES.some(
          (entry) => name === entry || name.startsWith(entry.endsWith("/") ? entry : `${entry}/`),
        ),
      )
      .map(([name, importer]) => `${importChain(importedBy, importer)} -> ${name}`);
    expect(reached).toEqual([]);
  });
});
