import type {
  PublicEnvironmentSummary,
  PublicProjectSummary,
  PublicSessionSummary,
  PublicSettingsSnapshot,
} from "@orkestrator/protocol/public-api-resources";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";

/** Human-mode formatting. Not a stable interface; scripts use --json. */

export function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["(none)"];
  const widths = headers.map((header, index) =>
    Math.min(60, Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => {
        const text = cell.length > widths[index]! ? `${cell.slice(0, widths[index]! - 1)}…` : cell;
        return text.padEnd(widths[index]!);
      })
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function keyValues(entries: Array<[string, unknown]>): string[] {
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text =
        value === null ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key.padEnd(width)}  ${text}`;
    });
}

export function projectLines(project: PublicProjectSummary): string[] {
  return keyValues([
    ["id", project.id],
    ["name", project.name],
    ["remote", project.gitUrl],
    ["path", project.localPath],
    ["folder", project.folder],
    ["environments", project.environmentCount],
    ["revision", project.revision],
  ]);
}

export function projectRows(projects: PublicProjectSummary[]): string[] {
  return table(
    ["ID", "NAME", "ENVS", "PATH"],
    projects.map((project) => [
      project.id,
      project.name,
      String(project.environmentCount),
      project.localPath ?? "-",
    ]),
  );
}

export function environmentLines(environment: PublicEnvironmentSummary): string[] {
  return keyValues([
    ["id", environment.id],
    ["project", environment.projectId],
    ["name", environment.name],
    ["branch", environment.branch],
    ["type", environment.environmentType],
    ["status", environment.status],
    ["ready", environment.ready],
    ["setup", `${environment.setup.phase}${environment.setup.overridden ? " (overridden)" : ""}`],
    ["activity", environment.activity.state],
    ["lifecycle error", environment.lifecycle.error],
    ["workspace", environment.workspacePath],
    ["base", environment.base.commit ?? environment.base.branch],
    ["startup session", environment.startupSession?.sessionId],
  ]);
}

export function environmentRows(environments: PublicEnvironmentSummary[]): string[] {
  return table(
    ["ID", "NAME", "TYPE", "STATUS", "READY"],
    environments.map((environment) => [
      environment.id,
      environment.name,
      environment.environmentType,
      environment.status,
      environment.ready ? "yes" : "no",
    ]),
  );
}

export function sessionRows(sessions: PublicSessionSummary[]): string[] {
  return table(
    ["SESSION", "AGENT", "TAB", "ACTIVITY", "TITLE"],
    sessions.map((session) => [
      session.id,
      session.agent,
      session.tabId,
      session.activity,
      session.title ?? "",
    ]),
  );
}

export function sessionLines(session: PublicSessionSummary): string[] {
  return keyValues([
    ["id", session.id],
    ["environment", session.environmentId],
    ["tab", session.tabId],
    ["agent", session.agent],
    ["title", session.title],
    ["activity", session.activity],
    ["latest request", session.latestRequestId],
    ["pending interactions", session.pendingInteractionCount],
    ["recoverable dispatch", session.recoverableDispatch],
  ]);
}

export function receiptLines(receipt: PublicReceipt): string[] {
  return keyValues([
    ["operation", receipt.operationId],
    ["action", receipt.action],
    ["state", receipt.state],
    ["stage", receipt.stage],
    ["request", `${receipt.requestId} (${receipt.namespace})`],
    ["replayed", receipt.replayed],
    ["resources", receipt.resources],
    ["dispatch", receipt.dispatch?.state],
    ["execution", receipt.execution?.state],
    ["evidence", receipt.execution?.evidence],
    ["exit code", receipt.execution?.exitCode],
    ["error", receipt.error ? `${receipt.error.code}: ${receipt.error.message}` : undefined],
    ["updated", receipt.updatedAt],
    ["retained until", receipt.retainedUntil],
  ]);
}

export function settingsLines(snapshot: PublicSettingsSnapshot): string[] {
  return [
    `revision ${snapshot.revision}`,
    ...table(
      ["KEY", "VALUE", "EFFECTIVE", "SOURCE", "APPLIES"],
      snapshot.settings.map((setting) => [
        setting.key,
        setting.value === null || setting.value === undefined ? "-" : JSON.stringify(setting.value),
        setting.effective === null || setting.effective === undefined
          ? "-"
          : JSON.stringify(setting.effective),
        setting.source,
        setting.application,
      ]),
    ),
  ];
}
