import { asWebModel, nativeSessions } from "@/lib/node-scope/domains/native-sessions";
import type {
  BugReportAgent,
  BugReportClientContext,
  BugReportFileResult,
  BugReportSnapshot,
} from "@orkestrator/protocol/bug-report";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createBugReportApi(client: BackendClient) {
  const invoke = clientInvoke(client);
  const native = () => nativeSessions(client);

  /** The Report a bug sheet's backend commands, on this view's own backend. */
  const getBugReport = (): Promise<BugReportSnapshot> => invoke("get_bug_report");

  const createBugReport = (clientContext: BugReportClientContext): Promise<BugReportSnapshot> =>
    invoke("create_bug_report", { clientContext });

  const assignBugReportAgent = (
    reportId: string,
    agent: BugReportAgent,
  ): Promise<BugReportSnapshot> => invoke("assign_bug_report_agent", { reportId, agent });

  const saveBugReportScreenshot = (
    reportId: string,
    base64Data: string,
  ): Promise<{ path: string; snapshot: BugReportSnapshot }> =>
    invoke("save_bug_report_screenshot", { reportId, base64Data });

  const writeBugReportAttachment = (
    reportId: string,
    filename: string,
    base64Data: string,
  ): Promise<string> => invoke("write_bug_report_attachment", { reportId, filename, base64Data });

  const fileBugReport = (
    reportId: string,
    issue: { title: string; body: string; via?: "browser" },
  ): Promise<BugReportFileResult> => invoke("file_bug_report", { reportId, ...issue });

  const markBugReportFiled = (reportId: string, url: string): Promise<BugReportSnapshot> =>
    invoke("mark_bug_report_filed", { reportId, url });

  const discardBugReport = (reportId: string): Promise<BugReportSnapshot> =>
    invoke("discard_bug_report", { reportId });

  const revealBugReportPath = (path: string): Promise<void> =>
    native().reveal_in_file_manager({ path });

  return {
    getBugReport,
    createBugReport,
    assignBugReportAgent,
    saveBugReportScreenshot,
    writeBugReportAttachment,
    fileBugReport,
    markBugReportFiled,
    discardBugReport,
    revealBugReportPath,
  };
}

export type BugReportApi = ReturnType<typeof createBugReportApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getBugReport,
  createBugReport,
  assignBugReportAgent,
  saveBugReportScreenshot,
  writeBugReportAttachment,
  fileBugReport,
  markBugReportFiled,
  discardBugReport,
  revealBugReportPath,
} = createBugReportApi(commandBackendClient);
