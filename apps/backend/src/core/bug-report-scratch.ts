/**
 * Where a bug report's scratch directory may live, kept apart from
 * `bug-report-service.ts` so the file readers can name a report's images
 * without importing the service (and the server lifecycle it pulls in).
 */
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BUG_REPORT_SCREENSHOT_DIRECTORY } from "@orkestrator/protocol/bug-report";

import type { ReadableHostRoot } from "./path-safety.js";
import type { BugReportsStorage } from "./storage-bug-reports.js";

export const BUG_REPORT_SCRATCH_PREFIX = "orkestrator-bug-report-";

/**
 * A directory the bug report service created: one directly under the
 * temporary directory, named with the report prefix. Only such a directory is
 * ever removed or read from.
 */
export function isOwnedBugReportScratchDir(scratchDir: string): boolean {
  if (!path.basename(scratchDir).startsWith(BUG_REPORT_SCRATCH_PREFIX)) return false;
  const parent = path.dirname(scratchDir);
  let tmp = os.tmpdir();
  try {
    tmp = realpathSync(tmp);
  } catch {
    // An unreadable temporary directory still names the parent literally.
  }
  return parent === tmp || parent === os.tmpdir();
}

/**
 * The image folders of the open bug reports: window captures and pasted
 * images. The report's transcript names them by absolute path, so the
 * environment-less file readers must admit them for the sheet to show them.
 * Only the `screenshots/` folder of a scratch directory this service owns is
 * listed, never the whole scratch directory.
 */
export async function bugReportImageRoots(
  bugReports: Pick<BugReportsStorage, "listBugReports"> | undefined,
): Promise<ReadableHostRoot[]> {
  if (!bugReports) return [];
  const reports = await bugReports.listBugReports().catch(() => []);
  return reports
    .filter((report) => isOwnedBugReportScratchDir(report.scratchDir))
    .map((report) => ({
      path: path.join(report.scratchDir, BUG_REPORT_SCREENSHOT_DIRECTORY),
      trustedParent: path.dirname(report.scratchDir),
    }));
}
