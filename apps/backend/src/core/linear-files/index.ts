/**
 * A Linear issue's files (docs/architecture/tickets.md, "Linear files"). The
 * agent tool is imported from `tool.ts`: the service needs the workspace
 * writers, which reach the agent tools server again.
 */
export { readLinearIssueFiles, issueFilesAreOnBoard } from "./issue-files.js";
export { LinearFileService, type PreparedBuildFiles } from "./service.js";
