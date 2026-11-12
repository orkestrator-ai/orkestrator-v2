/**
 * The exec-policy rules that let a sandbox-off read-only turn read.
 *
 * A read-only turn in a container runs without Codex's command sandbox under
 * the `untrusted` approval policy (`codex-read-only-sandbox.ts`), and the
 * bridge declines every approval that turn asks for. The pinned Codex
 * (0.167.0) has no list of known-safe commands under `untrusted`: a command
 * that matches no exec-policy rule always asks
 * (`render_decision_for_unmatched_command` in `core/src/exec_policy.rs`). So
 * without a rule every read was declined and the reviewer read nothing.
 *
 * Codex runs a command that an `allow` rule matches without asking, so the
 * bridge keeps one rules file of its own in `CODEX_HOME/rules/`, which Codex
 * reads whenever a thread starts or resumes (`ExecPolicyManager::load` in
 * `Session::new`). The bridge still never approves anything: every command
 * these rules do not allow still asks and is still declined.
 *
 * A prefix rule matches the leading words of a command and lets any
 * arguments follow, so it can only allow a program none of whose options
 * writes a file or runs another program. That leaves out `rg` (`--pre`),
 * `sed` (`w`, `-i`), `find` (`-exec`, `-delete`), `awk` (`system`), `sort`
 * (`-o`), `xargs` and `env`, and Git's `diff`, `show` and `log`
 * (`--output=<file>`). A reviewer reads a diff from its review package with
 * `cat` instead. A command with a redirection or a subshell is not split into
 * plain commands by Codex, so it matches no rule and is declined.
 *
 * This is not an exec-policy amendment (`AGENTS.md` forbids offering one):
 * the bridge owns this file, rewrites it whenever its content differs, and
 * writes it only for a sandbox-off read-only turn, which happens only inside
 * an environment's container. Every other Codex session on that
 * `CODEX_HOME` also runs these programs without asking afterwards, which is
 * the meaning `untrusted` had before Codex dropped its known-safe list.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Codex reads every `*.rules` file in `CODEX_HOME/rules/`. */
export const CODEX_READ_ONLY_RULES_FILENAME = "orkestrator-read-only.rules";

/** Programs that run without asking, with any arguments. */
export const CODEX_READ_ONLY_ALLOWED_PROGRAMS: readonly string[] = [
  "basename",
  "cat",
  "cmp",
  "comm",
  "cut",
  "diff",
  "dirname",
  "echo",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "readlink",
  "realpath",
  "stat",
  "tail",
  "wc",
];

/** `git <subcommand>` forms that run without asking, with any arguments. */
export const CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS: readonly string[] = [
  "ls-files",
  "merge-base",
  "rev-parse",
  "status",
];

function starlarkList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/** The rules file's content, in Codex's Starlark rule language. */
export function codexReadOnlyExecRules(): string {
  return [
    "# Written by Orkestrator's Codex bridge for read-only turns that run without",
    "# Codex's command sandbox. The bridge rewrites this file; edits are lost.",
    "prefix_rule(",
    `    pattern = [${starlarkList(CODEX_READ_ONLY_ALLOWED_PROGRAMS)}],`,
    '    decision = "allow",',
    '    justification = "Reads only: no option of these programs writes a file or runs another program.",',
    ")",
    "prefix_rule(",
    `    pattern = ["git", ${starlarkList(CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS)}],`,
    '    decision = "allow",',
    '    justification = "Git inspection subcommands with no option that writes a file.",',
    ")",
    "",
  ].join("\n");
}

/**
 * Tells the model which commands run, so it does not spend the turn on
 * commands that are declined. Added to a sandbox-off read-only thread's
 * developer instructions.
 */
export function codexReadOnlyExecRulesInstructions(): string {
  const git = CODEX_READ_ONLY_ALLOWED_GIT_SUBCOMMANDS.map((sub) => `git ${sub}`).join(", ");
  return [
    "This read-only turn runs without a command sandbox, so only these commands run;",
    "every other command is declined:",
    `${CODEX_READ_ONLY_ALLOWED_PROGRAMS.join(", ")}, and ${git}.`,
    "They may be chained with pipes, && or ; but not with redirection or subshells.",
    "Read diffs and other files with cat, head, tail or grep, not with rg, sed, find or git diff/show/log.",
  ].join(" ");
}

/**
 * Writes the rules file into `codexHome` unless it already holds exactly this
 * content. The write goes to a temporary name Codex does not read (it ends in
 * `.tmp`, not `.rules`) and is renamed into place, so a thread starting
 * meanwhile never parses half a file: a rules file Codex cannot parse fails
 * every thread start.
 */
export async function ensureCodexReadOnlyExecRules(codexHome: string): Promise<void> {
  const directory = join(codexHome, "rules");
  const path = join(directory, CODEX_READ_ONLY_RULES_FILENAME);
  const content = codexReadOnlyExecRules();
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return;
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
