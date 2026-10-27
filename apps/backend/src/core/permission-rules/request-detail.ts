import type { AgentInteractionQuestionAnswer } from "@orkestrator/protocol/agent-interactions";
import {
  PERMISSION_RULE_LIMITS,
  type PermissionRuleSubject,
} from "@orkestrator/protocol/permission-rules";
import type { PermissionRuleRequestDetail } from "../agent-provider-contract.js";

/**
 * What an Orkestrator permission rule (todo 0723) may match, read from each
 * bridge's own approval payload.
 *
 * Every reader fails closed: a request the bridge did not mark `ruleEligible`,
 * a detail that is missing, oversized or truncated, or a path that cannot be
 * placed, yields `null`, and the request is put to the user as before. The
 * presented card text is never parsed: it is bounded for display and may be
 * cut.
 */

type Raw = Record<string, unknown>;

function exactString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

/** A forwarded prefix proposal, or undefined; only ever a preselection hint. */
function proposal(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined;
  return value.every(
    (token) => typeof token === "string" && token.length > 0 && token.length <= 256,
  )
    ? [...(value as string[])]
    : undefined;
}

/** `path` as an absolute path, resolving a relative one against `cwd` when that is absolute. */
export function absolutePath(path: unknown, cwd: unknown): string | null {
  const value = exactString(path, PERMISSION_RULE_LIMITS.maxPathLength);
  if (!value || /^(?:~|@|file:)/i.test(value)) return null;
  if (value.startsWith("/")) return value;
  const base = exactString(cwd, PERMISSION_RULE_LIMITS.maxPathLength);
  if (!base || !base.startsWith("/")) return null;
  const joined = `${base.replace(/\/+$/, "")}/${value}`;
  return joined.length <= PERMISSION_RULE_LIMITS.maxPathLength ? joined : null;
}

function paths(values: unknown[], cwd: unknown): string[] | null {
  if (values.length === 0 || values.length > PERMISSION_RULE_LIMITS.maxPaths) return null;
  const resolved: string[] = [];
  for (const value of values) {
    const path = absolutePath(value, cwd);
    if (!path) return null;
    resolved.push(path);
  }
  return resolved;
}

function detail(
  subject: PermissionRuleSubject | null,
  extra: Partial<PermissionRuleRequestDetail> = {},
): PermissionRuleRequestDetail | null {
  return subject ? { subject, allowOnceAnswers: [], ...extra } : null;
}

/**
 * The Codex approval envelope, also served by Pi (`kind` command, file-change
 * or permissions). A managed-network prompt on a command is about the host,
 * not the command.
 */
export function codexRuleDetail(
  request: Raw,
  kind: "command-approval" | "file-approval" | "permission",
  actionable: boolean,
): PermissionRuleRequestDetail | null {
  if (request.ruleEligible !== true || !actionable) return null;
  if (kind === "command-approval") {
    const host = exactString(request.networkHost, 2_048);
    if (host) return detail({ kind: "network-host", host });
    const command = exactString(request.command, PERMISSION_RULE_LIMITS.maxCommandLength);
    const proposed = proposal(request.proposedCommandPrefix);
    return detail(
      command ? { kind: "command", command } : null,
      proposed ? { proposal: proposed } : {},
    );
  }
  if (kind === "file-approval") {
    if (request.grantRoot !== undefined) return null;
    const changes = Array.isArray(request.changes) ? request.changes : [];
    const resolved = paths(
      changes.flatMap((change) => {
        if (!change || typeof change !== "object") return [undefined];
        const entry = change as Raw;
        return entry.movePath === undefined ? [entry.path] : [entry.path, entry.movePath];
      }),
      request.cwd,
    );
    return detail(resolved ? { kind: "file-change", paths: resolved } : null);
  }
  return null;
}

/**
 * A Grok ACP approval. It is answered by selecting an option, so a rule may
 * only answer one that offers ACP's own `allow_once`: the bridge's fallback
 * for a bare approve may pick `allow_always`, which would save a rule in
 * Grok's own settings.
 */
export function acpRuleDetail(
  request: Raw,
  allowOnceOptionId: string | null,
  questionId: string,
): PermissionRuleRequestDetail | null {
  if (request.ruleEligible !== true || !allowOnceOptionId) return null;
  if (request.commandTruncated === true || (request.pathsOmitted ?? 0) !== 0) return null;
  const allowOnceAnswers: AgentInteractionQuestionAnswer[] = [
    { questionId, optionIds: [allowOnceOptionId] },
  ];
  if (request.kind === "command") {
    const command = exactString(request.command, PERMISSION_RULE_LIMITS.maxCommandLength);
    return detail(command ? { kind: "command", command } : null, { allowOnceAnswers });
  }
  if (request.kind === "file-change") {
    const resolved = Array.isArray(request.paths) ? paths(request.paths, undefined) : null;
    return detail(resolved ? { kind: "file-change", paths: resolved } : null, {
      allowOnceAnswers,
    });
  }
  return null;
}

/** Claude's `mcp__<server>__<tool>` naming; the server part is normalised by the CLI. */
function claudeMcpTool(toolName: string, server: string): string | null {
  const prefix = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
  return toolName.startsWith(prefix) && toolName.length > prefix.length
    ? toolName.slice(prefix.length)
    : null;
}

/** A Claude `ask`-policy tool approval from `/interactions`. */
export function claudeRuleDetail(
  request: Raw,
  kind: "command-approval" | "file-approval" | "permission",
): PermissionRuleRequestDetail | null {
  if (request.ruleEligible !== true) return null;
  if (kind === "command-approval") {
    const command = exactString(request.command, PERMISSION_RULE_LIMITS.maxCommandLength);
    const proposed = proposal(request.proposedCommandPrefix);
    return detail(
      command ? { kind: "command", command } : null,
      proposed ? { proposal: proposed } : {},
    );
  }
  if (kind === "file-approval") {
    const resolved = Array.isArray(request.paths) ? paths(request.paths, undefined) : null;
    return detail(resolved ? { kind: "file-change", paths: resolved } : null);
  }
  const host = exactString(request.networkHost, 2_048);
  if (host && request.toolName === "WebFetch") return detail({ kind: "network-host", host });
  const toolName = exactString(request.toolName, 256);
  const server = exactString(request.mcpServer, 256);
  if (toolName?.startsWith("mcp__") && server) {
    const tool = claudeMcpTool(toolName, server);
    return detail(tool ? { kind: "mcp-tool", server, tool } : null);
  }
  return null;
}

/**
 * An OpenCode permission request. OpenCode builds `patterns` from its own
 * parse of the command, which may leave out redirects and operators, so a
 * command is only matched from the full `metadata.command`, and only when it
 * is the one pattern asked about. Edits name an absolute `metadata.filepath`
 * or a pattern relative to the session's directory; a fetch names its URL.
 */
export function openCodeRuleDetail(
  request: Raw,
  permission: string,
  patterns: readonly string[],
  directory: string | undefined,
): PermissionRuleRequestDetail | null {
  const metadata =
    request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata)
      ? (request.metadata as Raw)
      : {};
  if (permission === "bash") {
    const command = exactString(metadata.command, PERMISSION_RULE_LIMITS.maxCommandLength);
    if (!command || patterns.length !== 1 || patterns[0] !== command) return null;
    return detail({ kind: "command", command });
  }
  if (permission === "edit" || permission === "write") {
    const filepath = absolutePath(metadata.filepath, undefined);
    if (filepath) return detail({ kind: "file-change", paths: [filepath] });
    if (patterns.length !== 1) return null;
    const resolved = absolutePath(patterns[0], directory);
    return detail(resolved ? { kind: "file-change", paths: [resolved] } : null);
  }
  if (permission === "webfetch" && patterns.length === 1) {
    const url = exactString(patterns[0], 8_192);
    return detail(url && /^https?:\/\//i.test(url) ? { kind: "network-host", host: url } : null);
  }
  return null;
}
