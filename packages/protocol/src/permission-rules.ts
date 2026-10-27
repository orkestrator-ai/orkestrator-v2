/**
 * Orkestrator-owned "always allow" rules for agent approvals.
 *
 * A rule lives in the backend's own store, never in a provider's files
 * (`~/.codex/rules/`, Claude's `settings.json`, …). When a provider asks for
 * approval, the backend looks for a matching rule and answers the request with
 * plain allow-once. Every answer on the wire is allow-once, so removing a rule
 * takes effect at once: the next matching request simply asks again.
 *
 * Matching fails closed. Anything this module cannot parse with certainty —
 * shell operators, expansions, escapes, wrappers, paths outside the workspace,
 * agent configuration directories — does not match, and the user is asked.
 * See docs/architecture/permission-rules.md.
 *
 * Pure and browser-safe: the renderer uses the same helpers to show the card's
 * pattern choices, and the backend to enforce them.
 */
// Type-only: agent-interactions.ts imports this module to validate the card's
// offer, so a runtime import back would be a cycle.
import type { AgentInteractionProvider } from "./agent-interactions.js";

export const PERMISSION_RULE_KINDS = [
  "command-prefix",
  "file-path",
  "network-host",
  "mcp-tool",
] as const;
export type PermissionRuleKind = (typeof PERMISSION_RULE_KINDS)[number];

/**
 * Where a rule applies. There is no host-wide scope (decision 1 of todo 0723):
 * every rule is tied to one project, and optionally narrowed to one of its
 * environments.
 */
export const PERMISSION_RULE_SCOPES = ["project", "environment"] as const;
export type PermissionRuleScope = (typeof PERMISSION_RULE_SCOPES)[number];

export type PermissionRuleProvider = AgentInteractionProvider | "any";

export const PERMISSION_RULE_LIMITS = Object.freeze({
  maxRules: 512,
  maxIdLength: 128,
  maxPatternLength: 1_024,
  maxCommandLength: 4_096,
  maxCommandTokens: 64,
  maxRuleTokens: 16,
  maxTokenLength: 256,
  maxPaths: 256,
  maxPathLength: 4_096,
  /** The longest expiry a card offers; a rule may also have none. */
  maxExpiryMs: 365 * 24 * 60 * 60 * 1_000,
});

/** Expiry choices the card offers, besides "until removed". */
export const PERMISSION_RULE_EXPIRY_CHOICES_MS = Object.freeze([
  24 * 60 * 60 * 1_000,
  7 * 24 * 60 * 60 * 1_000,
  30 * 24 * 60 * 60 * 1_000,
]);

/** The approval a rule was saved from. Identifiers only, never content. */
export interface PermissionRuleOrigin {
  environmentId: string;
  agent: AgentInteractionProvider;
  logicalSessionKey?: string;
  interactionId: string;
}

export interface NativeAgentPermissionRule {
  id: string;
  /** The provider the rule answers for; `any` answers every provider. */
  provider: PermissionRuleProvider;
  scope: PermissionRuleScope;
  projectId: string;
  /** Present exactly when `scope` is `environment`. */
  environmentId?: string;
  kind: PermissionRuleKind;
  /**
   * Canonical pattern, also what the UI shows:
   * - `command-prefix`: argv tokens joined by single spaces (`npm run test`).
   *   Every token is a plain word, so the join is unambiguous.
   * - `file-path`: a path relative to the environment's workspace. A trailing
   *   `/` covers a directory and everything below it; `./` is the whole
   *   workspace. Anything else is one file.
   * - `network-host`: a lower-case host name or IPv4 address, no port.
   * - `mcp-tool`: `server/tool`.
   */
  pattern: string;
  createdAt: number;
  createdFrom: PermissionRuleOrigin;
  lastUsedAt?: number;
  useCount: number;
  expiresAt?: number;
}

/** What one rule application recorded, for Agent Info and the transcript note. */
export interface PermissionRuleApplication {
  ruleId: string;
  /** The rule's pattern and kind when it applied; the rule may since be gone. */
  kind: PermissionRuleKind;
  pattern: string;
  scope: PermissionRuleScope;
  environmentId: string;
  agent: AgentInteractionProvider;
  logicalSessionKey: string;
  interactionId: string;
  appliedAt: number;
}

export interface PermissionRulesSnapshot {
  rules: NativeAgentPermissionRule[];
  /** Most recent applications, newest last. Bounded. */
  applications: PermissionRuleApplication[];
}

/**
 * What a provider asked to do, in the structured form rules match against.
 * Built by the backend from the bridge's payload; never from display text.
 */
export type PermissionRuleSubject =
  | { kind: "command"; command: string }
  | { kind: "file-change"; paths: string[] }
  | { kind: "network-host"; host: string }
  | { kind: "mcp-tool"; server: string; tool: string };

/** Where the request was raised, for scope and path matching. */
export interface PermissionRuleContext {
  provider: AgentInteractionProvider;
  projectId: string;
  environmentId: string;
  /**
   * The environment's workspace root as the agent sees it (a container path
   * for a container environment). File rules never match without one.
   */
  workspaceRoot?: string;
  now: number;
}

/**
 * The card's "Approve and remember" offer: the patterns the user may choose,
 * narrowest first, or why remembering is unavailable for this request.
 */
export interface PermissionRuleOffer {
  kind: PermissionRuleKind;
  /** Narrowest first. Empty when `unavailableReason` is set. */
  patterns: string[];
  /** Index into `patterns` the card preselects (the provider's own proposal, if valid). */
  suggested: number;
  unavailableReason?: string;
}

/** Mirrors `AGENT_INTERACTION_PROVIDERS`; a test pins the two together. */
export const PERMISSION_RULE_PROVIDERS = [
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
] as const satisfies readonly AgentInteractionProvider[];
const PROVIDERS = new Set<string>(PERMISSION_RULE_PROVIDERS);
const KINDS = new Set<string>(PERMISSION_RULE_KINDS);
const SCOPES = new Set<string>(PERMISSION_RULE_SCOPES);

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

/**
 * Split a command line into argv, or `null` when it is anything but a plain
 * list of words.
 *
 * Deliberately a strict subset of POSIX shell: single and double quotes are
 * honoured, and everything that could make the shell run something other than
 * the words it shows is refused — operators (`;`, `&`, `|`), redirects,
 * subshells, command and parameter substitution, backslash escapes, globs,
 * brace and tilde expansion, history expansion, comments, newlines and control
 * characters. Refusing a harmless command costs one question; accepting a
 * hostile one runs it unasked.
 */
export function parseShellWords(input: string): string[] | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (input.length > PERMISSION_RULE_LIMITS.maxCommandLength) return null;
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const char of input) {
    const code = char.codePointAt(0)!;
    // Newlines separate commands; other control characters have no business
    // in a command a person approved.
    if (code < 0x20 && char !== "\t") return null;
    if (code === 0x7f) return null;
    // Unicode line and paragraph separators, and bidi controls that make a
    // command read differently from what runs.
    if (
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return null;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "$" || char === "`" || char === "\\" || char === "!") return null;
      else current += char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (UNQUOTED_REFUSED.has(char)) return null;
    if (char === "~" && !inWord) return null;
    current += char;
    inWord = true;
    if (words.length >= PERMISSION_RULE_LIMITS.maxCommandTokens) return null;
  }
  if (quote !== null) return null;
  if (inWord) words.push(current);
  if (words.length === 0 || words.length > PERMISSION_RULE_LIMITS.maxCommandTokens) return null;
  return words;
}

const UNQUOTED_REFUSED = new Set([
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "`",
  "$",
  "\\",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "!",
  "#",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh"]);

/**
 * Commands that run another command, or whose arguments can. A rule never
 * names one, and a command that starts with one never matches.
 */
const WRAPPERS = new Set([
  ...SHELLS,
  "env",
  "sudo",
  "doas",
  "su",
  "exec",
  "eval",
  "command",
  "builtin",
  "nohup",
  "time",
  "timeout",
  "nice",
  "ionice",
  "chroot",
  "setsid",
  "stdbuf",
  "unbuffer",
  "flock",
  "script",
  "watch",
  "strace",
  "ltrace",
  "xargs",
  "parallel",
  "find",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "osascript",
]);

/**
 * Interpreters and package runners. A rule may name one only with a fixed
 * second word that is not an option: `python scripts/check.py` is a rule,
 * `python` or `python -c` is not.
 */
const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "lua",
  "npx",
  "bunx",
  "pnpx",
  "uvx",
  "pipx",
  "git",
  "docker",
  "kubectl",
]);

function commandName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function isShellWrapper(argv: readonly string[]): boolean {
  return SHELLS.has(commandName(argv[0] ?? ""));
}

/**
 * The argv a command line runs, or `null` when it cannot be known for sure.
 *
 * Codex sends commands through the user's shell (`/bin/zsh -lc 'npm test'`).
 * Exactly one `sh|bash|zsh|… -c|-lc '<script>'` layer is unwrapped, and only
 * when the script is itself a single plain command (decision 5). Any other use
 * of a shell, a wrapper such as `sudo` or `env`, or a leading `NAME=value`
 * assignment yields `null`.
 */
export function commandArgv(command: string): string[] | null {
  let argv = parseShellWords(command);
  if (!argv) return null;
  if (isShellWrapper(argv)) {
    if (argv.length !== 3 || (argv[1] !== "-c" && argv[1] !== "-lc")) return null;
    argv = parseShellWords(argv[2]!);
    if (!argv || isShellWrapper(argv)) return null;
  }
  const name = argv[0]!;
  if (name.length === 0 || name.includes("=")) return null;
  if (WRAPPERS.has(commandName(name))) return null;
  return argv;
}

const PLAIN_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Why `argv` may not be saved as a command prefix, or `null` when it may.
 * Shown on the card, so phrased for the user.
 */
export function commandPrefixRefusal(argv: readonly string[]): string | null {
  if (argv.length < 2) {
    return "A command rule needs at least two words, such as `npm test`.";
  }
  if (argv.length > PERMISSION_RULE_LIMITS.maxRuleTokens) {
    return `A command rule can have at most ${PERMISSION_RULE_LIMITS.maxRuleTokens} words.`;
  }
  for (const token of argv) {
    if (token.length > PERMISSION_RULE_LIMITS.maxTokenLength || !PLAIN_TOKEN.test(token)) {
      return "Only plain words (no quotes, spaces or special characters) can be remembered.";
    }
  }
  const name = commandName(argv[0]!);
  if (argv[0]!.includes("=") || WRAPPERS.has(name)) {
    return `\`${name}\` runs other commands, so it can't be remembered.`;
  }
  if (
    (INTERPRETERS.has(name) ||
      /^(?:python|pypy|node(?:js)?|ruby|perl|php|lua|luajit|deno|bun)(?:\d+(?:\.\d+)*)?$/.test(
        name,
      )) &&
    argv[1]!.startsWith("-")
  ) {
    return `\`${name}\` with an option first could run anything, so it can't be remembered.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Directory and file names an automatic approval never covers. Writing to any
 * of them can widen what an agent is allowed to do (agent settings, MCP
 * configuration, git hooks, CI) or leak credentials (`.env*`).
 */
const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".github",
  ".claude",
  ".codex",
  ".cursor",
  ".opencode",
  ".grok",
  ".pi",
  ".agents",
  ".orkestrator",
  ".vscode",
  ".idea",
  ".husky",
  ".mcp.json",
]);

function isProtectedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return PROTECTED_SEGMENTS.has(lower) || lower.startsWith(".env");
}

/**
 * Lexically normalise an absolute POSIX path, or `null` when it is not one or
 * climbs above `/`. Symlinks are not resolved: a container path cannot be
 * resolved from the host. Runtime enforcers must additionally reject symlink
 * targets and ancestors in the agent filesystem before offering or applying file rules.
 */
export function normalizeAbsolutePath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (path.length > PERMISSION_RULE_LIMITS.maxPathLength) return null;
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * `path` relative to `root` (`""` for the root itself), or `null` when it is
 * outside it, unparseable, or inside a protected directory.
 */
export function workspaceRelativePath(root: string, path: string): string | null {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedPath = normalizeAbsolutePath(path);
  if (!normalizedRoot || !normalizedPath) return null;
  let relative: string;
  if (normalizedPath === normalizedRoot) relative = "";
  else if (normalizedRoot === "/") relative = normalizedPath.slice(1);
  else if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    relative = normalizedPath.slice(normalizedRoot.length + 1);
  } else return null;
  if (relative.split("/").some((segment) => segment !== "" && isProtectedSegment(segment))) {
    return null;
  }
  return relative;
}

/** Whether `pattern` is a canonical `file-path` pattern (see the rule's `pattern`). */
export function isFilePathPattern(pattern: string): boolean {
  if (pattern === "./") return true;
  if (pattern.length === 0 || pattern.length > PERMISSION_RULE_LIMITS.maxPatternLength) {
    return false;
  }
  if (pattern.startsWith("/")) return false;
  const body = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (body.length === 0) return false;
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(body)) return false;
  return body
    .split("/")
    .every(
      (segment) =>
        segment !== "" && segment !== "." && segment !== ".." && !isProtectedSegment(segment),
    );
}

// ---------------------------------------------------------------------------
// Hosts and MCP tools
// ---------------------------------------------------------------------------

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A host name or IPv4 address in canonical form (lower case, no trailing dot,
 * no port, no scheme), or `null`. A URL is accepted and reduced to its host.
 */
export function normalizeNetworkHost(value: string): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 2_048) return null;
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  if (host.includes("@") || host.includes("/") || host.startsWith("[")) return null;
  const port = /^(.*):(\d{1,5})$/.exec(host);
  if (port) host = port[1]!;
  if (host.endsWith(".")) host = host.slice(0, -1);
  return HOST_NAME.test(host) ? host : null;
}

const MCP_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function mcpToolPattern(server: string, tool: string): string | null {
  return MCP_NAME.test(server) && MCP_NAME.test(tool) ? `${server}/${tool}` : null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Whether `pattern` is canonical for `kind`. */
export function isPermissionRulePattern(kind: PermissionRuleKind, pattern: unknown): boolean {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (pattern.length > PERMISSION_RULE_LIMITS.maxPatternLength) return false;
  switch (kind) {
    case "command-prefix": {
      const argv = pattern.split(" ");
      return argv.join(" ") === pattern && commandPrefixRefusal(argv) === null;
    }
    case "file-path":
      return isFilePathPattern(pattern);
    case "network-host":
      return normalizeNetworkHost(pattern) === pattern;
    case "mcp-tool": {
      const slash = pattern.indexOf("/");
      return (
        slash > 0 && mcpToolPattern(pattern.slice(0, slash), pattern.slice(slash + 1)) === pattern
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PERMISSION_RULE_LIMITS.maxIdLength
  );
}

function isLongId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProvider(value: unknown): value is AgentInteractionProvider {
  return typeof value === "string" && PROVIDERS.has(value);
}

export function isPermissionRuleKind(value: unknown): value is PermissionRuleKind {
  return typeof value === "string" && KINDS.has(value);
}

export function isPermissionRuleScope(value: unknown): value is PermissionRuleScope {
  return typeof value === "string" && SCOPES.has(value);
}

/** A validated copy of a stored or received rule, or `null`. Unknown keys are dropped. */
export function parsePermissionRule(value: unknown): NativeAgentPermissionRule | null {
  if (!isRecord(value)) return null;
  const origin = value.createdFrom;
  if (
    !isId(value.id) ||
    !(value.provider === "any" || isProvider(value.provider)) ||
    !isPermissionRuleScope(value.scope) ||
    !isId(value.projectId) ||
    !isPermissionRuleKind(value.kind) ||
    !isPermissionRulePattern(value.kind, value.pattern) ||
    !isEpoch(value.createdAt) ||
    !isEpoch(value.useCount) ||
    (value.lastUsedAt !== undefined && !isEpoch(value.lastUsedAt)) ||
    (value.expiresAt !== undefined && !isEpoch(value.expiresAt)) ||
    !isRecord(origin) ||
    !isId(origin.environmentId) ||
    !isProvider(origin.agent) ||
    !isLongId(origin.interactionId) ||
    (origin.logicalSessionKey !== undefined && !isLongId(origin.logicalSessionKey))
  ) {
    return null;
  }
  if ((value.scope === "environment") !== isId(value.environmentId)) return null;
  if (value.scope === "project" && value.environmentId !== undefined) return null;
  return {
    id: value.id,
    provider: value.provider as PermissionRuleProvider,
    scope: value.scope,
    projectId: value.projectId,
    ...(value.scope === "environment" ? { environmentId: value.environmentId as string } : {}),
    kind: value.kind,
    pattern: value.pattern as string,
    createdAt: value.createdAt,
    createdFrom: {
      environmentId: origin.environmentId,
      agent: origin.agent,
      ...(origin.logicalSessionKey === undefined
        ? {}
        : { logicalSessionKey: origin.logicalSessionKey as string }),
      interactionId: origin.interactionId,
    },
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt as number }),
    useCount: value.useCount,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number }),
  };
}

export function parsePermissionRuleApplication(value: unknown): PermissionRuleApplication | null {
  if (!isRecord(value)) return null;
  if (
    !isId(value.ruleId) ||
    !isPermissionRuleKind(value.kind) ||
    typeof value.pattern !== "string" ||
    value.pattern.length === 0 ||
    value.pattern.length > PERMISSION_RULE_LIMITS.maxPatternLength ||
    !isPermissionRuleScope(value.scope) ||
    !isId(value.environmentId) ||
    !isProvider(value.agent) ||
    !isLongId(value.logicalSessionKey) ||
    !isLongId(value.interactionId) ||
    !isEpoch(value.appliedAt)
  ) {
    return null;
  }
  return {
    ruleId: value.ruleId,
    kind: value.kind,
    pattern: value.pattern,
    scope: value.scope,
    environmentId: value.environmentId,
    agent: value.agent,
    logicalSessionKey: value.logicalSessionKey,
    interactionId: value.interactionId,
    appliedAt: value.appliedAt,
  };
}

export function parsePermissionRuleOffer(value: unknown): PermissionRuleOffer | null {
  if (!isRecord(value) || !isPermissionRuleKind(value.kind)) return null;
  const kind = value.kind;
  if (
    !Array.isArray(value.patterns) ||
    value.patterns.length > PERMISSION_RULE_LIMITS.maxRuleTokens
  )
    return null;
  if (!value.patterns.every((pattern) => isPermissionRulePattern(kind, pattern))) return null;
  const patterns = value.patterns as string[];
  if (
    value.unavailableReason !== undefined &&
    (typeof value.unavailableReason !== "string" ||
      value.unavailableReason.length === 0 ||
      value.unavailableReason.length > 512)
  ) {
    return null;
  }
  if ((value.unavailableReason === undefined) === (patterns.length === 0)) return null;
  const suggested = value.suggested;
  if (
    !Number.isSafeInteger(suggested) ||
    (suggested as number) < 0 ||
    (patterns.length > 0 && (suggested as number) >= patterns.length) ||
    (patterns.length === 0 && suggested !== 0)
  ) {
    return null;
  }
  return {
    kind,
    patterns: [...patterns],
    suggested: suggested as number,
    ...(value.unavailableReason === undefined
      ? {}
      : { unavailableReason: value.unavailableReason as string }),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** The rule kind that can answer `subject`. */
export function permissionRuleKindFor(subject: PermissionRuleSubject): PermissionRuleKind {
  switch (subject.kind) {
    case "command":
      return "command-prefix";
    case "file-change":
      return "file-path";
    case "network-host":
      return "network-host";
    case "mcp-tool":
      return "mcp-tool";
  }
}

/** Whether `rule` is in force for `context`: provider, scope and expiry. */
export function permissionRuleApplies(
  rule: NativeAgentPermissionRule,
  context: Pick<PermissionRuleContext, "provider" | "projectId" | "environmentId" | "now">,
): boolean {
  if (rule.provider !== "any" && rule.provider !== context.provider) return false;
  if (rule.projectId !== context.projectId) return false;
  if (rule.scope === "environment" && rule.environmentId !== context.environmentId) return false;
  if (rule.expiresAt !== undefined && rule.expiresAt <= context.now) return false;
  return true;
}

/** Whether `rule`'s pattern covers `subject`. Scope is not checked here. */
export function permissionRuleCovers(
  rule: Pick<NativeAgentPermissionRule, "kind" | "pattern">,
  subject: PermissionRuleSubject,
  workspaceRoot?: string,
): boolean {
  if (rule.kind !== permissionRuleKindFor(subject)) return false;
  if (!isPermissionRulePattern(rule.kind, rule.pattern)) return false;
  switch (subject.kind) {
    case "command": {
      const argv = commandArgv(subject.command);
      if (!argv) return false;
      const prefix = rule.pattern.split(" ");
      if (argv.length < prefix.length) return false;
      return prefix.every((token, index) => argv[index] === token);
    }
    case "file-change": {
      if (!workspaceRoot) return false;
      if (subject.paths.length === 0 || subject.paths.length > PERMISSION_RULE_LIMITS.maxPaths) {
        return false;
      }
      return subject.paths.every((path) => {
        const relative = workspaceRelativePath(workspaceRoot, path);
        if (relative === null || relative === "") return false;
        if (rule.pattern === "./") return true;
        if (rule.pattern.endsWith("/")) return relative.startsWith(rule.pattern);
        return relative === rule.pattern;
      });
    }
    case "network-host":
      return normalizeNetworkHost(subject.host) === rule.pattern;
    case "mcp-tool":
      return mcpToolPattern(subject.server, subject.tool) === rule.pattern;
  }
}

/**
 * The rule that answers `subject`, or `null`. When several do, the narrowest
 * wins (environment before project, one provider before `any`, longer pattern
 * before shorter), then the oldest, so the choice is deterministic.
 */
export function findPermissionRule(
  rules: readonly NativeAgentPermissionRule[],
  subject: PermissionRuleSubject,
  context: PermissionRuleContext,
): NativeAgentPermissionRule | null {
  let best: NativeAgentPermissionRule | null = null;
  for (const rule of rules) {
    if (!permissionRuleApplies(rule, context)) continue;
    if (!permissionRuleCovers(rule, subject, context.workspaceRoot)) continue;
    if (!best || compareSpecificity(rule, best) < 0) best = rule;
  }
  return best;
}

function compareSpecificity(left: NativeAgentPermissionRule, right: NativeAgentPermissionRule) {
  const scope = Number(left.scope !== "environment") - Number(right.scope !== "environment");
  if (scope !== 0) return scope;
  const provider = Number(left.provider === "any") - Number(right.provider === "any");
  if (provider !== 0) return provider;
  if (left.pattern.length !== right.pattern.length) {
    return right.pattern.length - left.pattern.length;
  }
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

function unavailable(kind: PermissionRuleKind, reason: string): PermissionRuleOffer {
  return { kind, patterns: [], suggested: 0, unavailableReason: reason };
}

/**
 * The patterns a card may offer for `subject`, narrowest first.
 *
 * `proposal` is the provider's own suggestion (Codex's
 * `proposedExecpolicyAmendment`, a Claude `canUseTool` rule). It only chooses
 * which offered pattern is preselected; it can never add one the matcher
 * would not accept.
 */
export function permissionRuleOffer(
  subject: PermissionRuleSubject,
  options: { workspaceRoot?: string; proposal?: readonly string[] } = {},
): PermissionRuleOffer {
  switch (subject.kind) {
    case "command": {
      const argv = commandArgv(subject.command);
      if (!argv) {
        return unavailable(
          "command-prefix",
          "This command uses shell operators, expansions or a wrapper, so it can't be remembered.",
        );
      }
      const patterns: string[] = [];
      let reason: string | null = null;
      for (
        let length = Math.min(argv.length, PERMISSION_RULE_LIMITS.maxRuleTokens);
        length >= 2;
        length -= 1
      ) {
        const prefix = argv.slice(0, length);
        const refusal = commandPrefixRefusal(prefix);
        if (refusal) {
          reason ??= refusal;
          continue;
        }
        const pattern = prefix.join(" ");
        if (isPermissionRulePattern("command-prefix", pattern)) patterns.push(pattern);
      }
      if (patterns.length === 0) {
        return unavailable(
          "command-prefix",
          reason ?? "This command has no prefix within the rule size limits.",
        );
      }
      const proposed = options.proposal ? patterns.indexOf(options.proposal.join(" ")) : -1;
      return { kind: "command-prefix", patterns, suggested: Math.max(0, proposed) };
    }
    case "file-change": {
      if (!options.workspaceRoot) {
        return unavailable("file-path", "The workspace location is unknown here.");
      }
      const relatives: string[] = [];
      for (const path of subject.paths.slice(0, PERMISSION_RULE_LIMITS.maxPaths + 1)) {
        const relative = workspaceRelativePath(options.workspaceRoot, path);
        if (relative === null || relative === "") {
          return unavailable(
            "file-path",
            "Only files inside the workspace, outside agent and git settings, can be remembered.",
          );
        }
        relatives.push(relative);
      }
      if (relatives.length === 0 || relatives.length > PERMISSION_RULE_LIMITS.maxPaths) {
        return unavailable("file-path", "This change has too many files to remember.");
      }
      const patterns: string[] = [];
      if (relatives.length === 1 && isFilePathPattern(relatives[0]!)) patterns.push(relatives[0]!);
      // Every directory that contains all of the files, deepest first.
      const directories = relatives.map((relative) => relative.split("/").slice(0, -1));
      const common: string[] = [];
      for (let index = 0; ; index += 1) {
        const segment = directories[0]![index];
        if (segment === undefined || directories.some((dir) => dir[index] !== segment)) break;
        common.push(segment);
      }
      for (let length = common.length; length >= 1; length -= 1) {
        const pattern = `${common.slice(0, length).join("/")}/`;
        if (isFilePathPattern(pattern)) patterns.push(pattern);
      }
      patterns.splice(PERMISSION_RULE_LIMITS.maxRuleTokens - 1);
      patterns.push("./");
      return { kind: "file-path", patterns, suggested: 0 };
    }
    case "network-host": {
      const host = normalizeNetworkHost(subject.host);
      return host
        ? { kind: "network-host", patterns: [host], suggested: 0 }
        : unavailable("network-host", "This host name can't be remembered.");
    }
    case "mcp-tool": {
      const pattern = mcpToolPattern(subject.server, subject.tool);
      return pattern
        ? { kind: "mcp-tool", patterns: [pattern], suggested: 0 }
        : unavailable("mcp-tool", "This tool name can't be remembered.");
    }
  }
}

/** A short, human label for a rule: `Command npm test`, `Files in src/`, … */
export function describePermissionRule(rule: Pick<NativeAgentPermissionRule, "kind" | "pattern">) {
  switch (rule.kind) {
    case "command-prefix":
      return `Commands starting \`${rule.pattern}\``;
    case "file-path":
      return rule.pattern === "./"
        ? "File changes anywhere in the workspace"
        : rule.pattern.endsWith("/")
          ? `File changes in \`${rule.pattern}\``
          : `File changes to \`${rule.pattern}\``;
    case "network-host":
      return `Network access to \`${rule.pattern}\``;
    case "mcp-tool":
      return `MCP tool \`${rule.pattern}\``;
  }
}

// ---------------------------------------------------------------------------
// Rules outside Orkestrator (read-only)
// ---------------------------------------------------------------------------

/**
 * A file in which a provider keeps its own "always allow" rules: Codex's
 * `rules/*.rules` (Starlark `prefix_rule(...)`, including any saved by the
 * Codex amendment options removed in todo 0160) and Claude's
 * `permissions.allow` in its settings files. Orkestrator only shows these; it
 * never edits them, because neither provider documents a format or offers an
 * API Orkestrator could change them through.
 */
export interface ExternalPermissionRuleFile {
  provider: "codex" | "claude";
  /** The host login, an added account, a project checkout, or a container. */
  location: "host" | "account" | "project" | "container";
  /** Short human label, e.g. "Host Codex home" or "feature-x (container)". */
  label: string;
  path: string;
  environmentId?: string;
  /** Raw rule entries in the provider's own syntax, bounded. */
  entries: string[];
  truncated: boolean;
  /** Set when the file exists but could not be read or parsed. */
  error?: string;
  /** How to change these, in the provider's own terms. */
  guidance: string;
}

export interface ExternalPermissionRulesSnapshot {
  files: ExternalPermissionRuleFile[];
}
