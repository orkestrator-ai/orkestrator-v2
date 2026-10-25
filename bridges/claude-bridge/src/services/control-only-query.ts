/**
 * A Claude query opened only for its control channel (commands, models,
 * account, MCP status, plan usage). It must never run a turn.
 *
 * `maxTurns: 0` does not ensure that. Agent SDK 0.3.309 passes `--max-turns`
 * to the CLI only when the value is truthy, so a zero is dropped, and a string
 * prompt — even `""` — is sent as a user message that starts a real model turn
 * while the caller is still reading its control answer. Observed live on CLI
 * 2.1.296: a `prompt: ""` probe whose stream was read ran three model calls and
 * two Bash tool calls, and every probe that closed early still left an empty
 * session file under the user's `~/.claude/projects`.
 *
 * A streaming input that never yields sends no message at all: the CLI still
 * initializes and answers control requests, writes no session, and runs
 * nothing. The caller still owns `close()`.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function controlOnlyQuery(options: Options): Query {
  return query({ prompt: noMessages(), options });
}

/** Never yields. A pending promise holds no timer, so it never keeps the process alive. */
function noMessages(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
    }),
  };
}
