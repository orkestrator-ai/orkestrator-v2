# 07 — Bound and correct Codex template compatibility

Status: proposed. Dependencies: 02–04 and the identity model in 06.
[Index](00-index.md).

## Purpose and owners

Keep existing project/user prompt-file workflows usable while making clear that
they are implemented by Orkestrator. Work in
`bridges/codex-bridge/src/prompts/slash-commands.ts`, its tests,
`app-server-runtime-prompt.ts`, prompt dispatch records, and the catalogue
adapter. Split discovery, parsing, and execution policy into small modules if
the existing file becomes unwieldy.

## Discovery and identity

1. Preserve the current project-before-user effective precedence where there
   is no reserved-name collision. Record origin and shadowed status privately.
2. Decide reserved built-ins once. Recommended: reserve `/help`, `/models`,
   and the qualified runtime action names. A colliding template is unavailable
   with a rename explanation unless the adapter implements a real alternate
   address. Do not advertise a template that dispatch always bypasses.
3. Read only bounded metadata for catalogue display. Load the chosen body at
   invocation, with a fingerprint that detects edits between selection and
   preparation. Avoid storing every full prompt body in the catalogue cache.
4. Preserve existing frontmatter fields; recognize `argument-hint` as well as
   legacy `argument_hint`/`arguments`. Define precedence between spellings and
   reject malformed metadata predictably. Do not silently pretend the current
   line parser supports arbitrary YAML.
5. Keep the project and user locations explicitly documented as compatibility
   locations. Do not rename or migrate users' files automatically.

## Resource budgets

Introduce named, tested limits. Starting proposals: 512 accepted templates,
2,048 visited directory entries, depth 8, 256 KiB per template, 8 MiB aggregate
scan bytes, and 1 MiB expanded text, subject to stricter existing prompt limits.
Use UTF-8 byte measurement. Report truncation/skipped oversized entries without
logging their bodies. A limit must not produce an executable row whose body
cannot later be loaded safely.

Keep traversal within explicitly configured roots. Do not follow directory
symlinks without a separately specified canonical-root policy; avoid loops and
escapes. Bound concurrent file reads, close handles, handle atomic file
replacement, and treat deletion as stale selection before dispatch.

## Arguments and expansion

Use shared lexical parsing so tabs and multiline argument suffixes are handled
consistently. Keep `$ARGUMENTS` behavior as the supported baseline. Do not add
positional/named argument syntax until its exact grammar and missing-argument
behavior are specified and tested. Document unsupported syntax rather than
approximating a provider's different template language.

Maintain separate original text, resolved template identity, argument suffix,
and expanded payload. Validate expansion size before provider dispatch. A
failed expansion is a command error; it must not become a plain prompt or
model-generated interpretation of the error string.

## Inline shell substitution

Disable `!`-backtick execution by default. When an explicitly selected template
contains executable fragments, fail before execution with a message explaining
that this compatibility feature requires a supported execution policy. Preserve
the user's draft. Do not send half-expanded shell syntax to the model and call
the template successfully executed.

If retaining an opt-in mode is approved as part of implementation design:

1. Parse executable spans from the original template before substituting user
   arguments. Argument text may never introduce new executable spans.
2. Specify whether arguments may enter an executable span at all. Recommended
   initial rule: reject interpolation into shell spans; do not attempt ad hoc
   quoting of a whole shell language.
3. Route execution through a policy-enforced, observable executor with explicit
   cwd/environment, deadline, cancellation, count, per-output and aggregate
   byte bounds. Removing credentials alone is not a sandbox or approval policy.
4. Persist preparation identity before side effects. If the process dies before
   preparation completion is known, reconcile/park; do not repeat the shell
   command on a dispatch retry.
5. Deny unsupported policy, timeout, or approval outcomes; never auto-approve.

This optional executor is a separate deliverable. The main slash-command
improvement can ship with shell expansion disabled and a clear migration note.

## Tests and acceptance

- Project/user collision and all reserved names resolve identically in picker,
  help, typed dispatch, and selected dispatch.
- Multiline/tab/quoted/free-text arguments preserve content; argument strings
  containing shell-fragment syntax never execute anything.
- Oversized bodies, broad/deep trees, Unicode sizes, symlinks, removed files,
  and changed fingerprints have deterministic bounded outcomes.
- Template expansion executes once for a request and survives queue/retry
  identity checks; ambiguous preparation cannot be repeated automatically.
- Text-only legacy templates still work; shell templates fail explicitly under
  the default policy with no side effects.
- No full template bodies leak through inventory, telemetry, or error logs.
