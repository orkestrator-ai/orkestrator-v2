import { findUnsafeDomAbsenceAssertions } from "./dom-assertion-safety";
import { underDirectoryNamed, type SourceIndex } from "./source-guards/repository-index";

// Dependencies and generated copies are not repository test sources. Do not
// descend into them: installed dependencies must not determine the scan cost.
const excludedDirectories: ReadonlySet<string> = new Set(["node_modules", "dist", ".git"]);
const SCANNED_ROOTS = ["tests", "apps", "bridges"];
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Test files that pass a DOM-producing query result straight to `toBeNull`,
 * repository-relative and sorted.
 *
 * The scanner only reports a `.toBeNull()` member call, which a source can
 * hold only if it contains the text `toBeNull`, so files without it are not
 * parsed (about two thirds of them). A candidate that does not parse fails
 * the scan rather than passing on a partial tree.
 */
export function scanDomAbsenceAssertions(index: SourceIndex): string[] {
  const offenders: string[] = [];
  for (const file of index.files) {
    if (!SCANNED_ROOTS.some((root) => file.startsWith(`${root}/`))) continue;
    if (!TEST_FILE.test(file) || underDirectoryNamed(file, excludedDirectories)) continue;
    const source = index.read(file);
    if (source === null || !source.includes("toBeNull")) continue;
    if (findUnsafeDomAbsenceAssertions(file, source).length > 0) offenders.push(file);
  }
  return offenders.sort();
}
