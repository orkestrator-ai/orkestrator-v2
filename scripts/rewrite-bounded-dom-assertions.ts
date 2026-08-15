import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewriteUnsafeDomAbsenceAssertions } from "../tests/dom-assertion-safety";

const root = path.resolve(import.meta.dir, "..");
const sourceRoots = [path.join(root, "tests"), path.join(root, "apps"), path.join(root, "bridges")];

async function rewriteDirectory(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let changed = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) changed += await rewriteDirectory(target);
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = await readFile(target, "utf8");
      const rewritten = rewriteUnsafeDomAbsenceAssertions(target, source);
      if (rewritten !== source) {
        await writeFile(target, rewritten);
        changed += 1;
      }
    }
  }
  return changed;
}

let changed = 0;
for (const sourceRoot of sourceRoots) changed += await rewriteDirectory(sourceRoot);
console.log(`Rewrote unsafe DOM absence assertions in ${changed} file(s).`);
