import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findUnsafeDomAbsenceAssertions } from "./dom-assertion-safety";

// Dependencies and generated copies are not repository test sources. Do not
// descend into them: installed dependencies must not determine the scan cost.
const excludedDirectories = new Set(["node_modules", "dist", ".git"]);

export function scanDomAbsenceAssertions(root: string): string[] {
  const offenders: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(file);
      } else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        if (findUnsafeDomAbsenceAssertions(file, readFileSync(file, "utf8")).length > 0) {
          offenders.push(path.relative(root, file));
        }
      }
    }
  };
  for (const sourceRoot of ["tests", "apps", "bridges"]) visit(path.join(root, sourceRoot));
  return offenders.sort();
}
