import type {
  BugReportAgent,
  BugReportClientContext,
  BugReportFileResult,
  BugReportSnapshot,
} from "@orkestrator/protocol/bug-report";
import { invoke } from "@/lib/native/backend";

/** The Report a bug sheet's backend commands, on this view's own backend. */
export const getBugReport = (): Promise<BugReportSnapshot> => invoke("get_bug_report");

export const createBugReport = (
  clientContext: BugReportClientContext,
): Promise<BugReportSnapshot> => invoke("create_bug_report", { clientContext });

export const assignBugReportAgent = (
  reportId: string,
  agent: BugReportAgent,
): Promise<BugReportSnapshot> => invoke("assign_bug_report_agent", { reportId, agent });

export const saveBugReportScreenshot = (
  reportId: string,
  base64Data: string,
): Promise<{ path: string; snapshot: BugReportSnapshot }> =>
  invoke("save_bug_report_screenshot", { reportId, base64Data });

export const fileBugReport = (
  reportId: string,
  issue: { title: string; body: string; via?: "browser" },
): Promise<BugReportFileResult> => invoke("file_bug_report", { reportId, ...issue });

export const markBugReportFiled = (reportId: string, url: string): Promise<BugReportSnapshot> =>
  invoke("mark_bug_report_filed", { reportId, url });

export const discardBugReport = (reportId: string): Promise<BugReportSnapshot> =>
  invoke("discard_bug_report", { reportId });

export const revealBugReportPath = (path: string): Promise<void> =>
  invoke("reveal_in_file_manager", { path });
