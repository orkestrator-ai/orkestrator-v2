import type { CommandRegistrar } from "./commands-registry-types.js";
import { asString, assertOnlyKeys } from "./commands-validation.js";
import {
  assignBugReportAgent,
  createBugReport,
  discardBugReport,
  fileBugReport,
  getBugReportSnapshot,
  markBugReportFiled,
  saveBugReportScreenshot,
} from "./bug-report-service.js";

/** The Report a bug sheet (`bug-report-service.ts`). */
export function registerBugReportCommands(register: CommandRegistrar): void {
  register("get_bug_report", (args, context) => {
    assertOnlyKeys(args, [], "get_bug_report argument");
    return getBugReportSnapshot(context);
  });
  register("create_bug_report", (args, context) => {
    assertOnlyKeys(args, ["clientContext"], "create_bug_report argument");
    return createBugReport(context, args.clientContext);
  });
  register("assign_bug_report_agent", (args, context) => {
    assertOnlyKeys(args, ["reportId", "agent"], "assign_bug_report_agent argument");
    return assignBugReportAgent(context, asString(args.reportId, "reportId"), args.agent);
  });
  register("save_bug_report_screenshot", async (args, context) => {
    assertOnlyKeys(args, ["reportId", "base64Data"], "save_bug_report_screenshot argument");
    return saveBugReportScreenshot(context, asString(args.reportId, "reportId"), args.base64Data);
  });
  register("file_bug_report", (args, context) => {
    assertOnlyKeys(args, ["reportId", "title", "body", "via"], "file_bug_report argument");
    return fileBugReport(context, asString(args.reportId, "reportId"), {
      title: args.title,
      body: args.body,
      via: args.via,
    });
  });
  register("mark_bug_report_filed", (args, context) => {
    assertOnlyKeys(args, ["reportId", "url"], "mark_bug_report_filed argument");
    return markBugReportFiled(context, asString(args.reportId, "reportId"), args.url);
  });
  register("discard_bug_report", (args, context) => {
    assertOnlyKeys(args, ["reportId"], "discard_bug_report argument");
    return discardBugReport(context, asString(args.reportId, "reportId"));
  });
}
