import {
  assignBugReportAgentCommand,
  createBugReportCommand,
  discardBugReportCommand,
  fileBugReportCommand,
  getBugReportCommand,
  markBugReportFiledCommand,
  saveBugReportScreenshotCommand,
  writeBugReportAttachmentCommand,
} from "@orkestrator/protocol/contract/domains/system";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  assignBugReportAgent,
  createBugReport,
  discardBugReport,
  fileBugReport,
  getBugReportSnapshot,
  markBugReportFiled,
  saveBugReportScreenshot,
  writeBugReportAttachment,
} from "./bug-report-service.js";

/**
 * The Report a bug sheet (`bug-report-service.ts`). The definitions decode the
 * arguments (unknown keys are dropped); the service validates the values.
 */
export function registerBugReportCommands(register: CommandRegistrar): void {
  register(getBugReportCommand, (_args, context) => getBugReportSnapshot(context));
  register(createBugReportCommand, (args, context) => createBugReport(context, args.clientContext));
  register(assignBugReportAgentCommand, (args, context) =>
    assignBugReportAgent(context, args.reportId, args.agent),
  );
  register(saveBugReportScreenshotCommand, (args, context) =>
    saveBugReportScreenshot(context, args.reportId, args.base64Data),
  );
  register(writeBugReportAttachmentCommand, (args, context) =>
    writeBugReportAttachment(context, args.reportId, args.filename, args.base64Data),
  );
  register(fileBugReportCommand, (args, context) =>
    fileBugReport(context, args.reportId, { title: args.title, body: args.body, via: args.via }),
  );
  register(markBugReportFiledCommand, (args, context) =>
    markBugReportFiled(context, args.reportId, args.url),
  );
  register(discardBugReportCommand, (args, context) => discardBugReport(context, args.reportId));
}
