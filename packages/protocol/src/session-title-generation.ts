/**
 * Which agent logins may write a native session's title.
 *
 * A generated title sends the first message of a session to the model that
 * writes it. Only Codex and Claude have a title generator, so with
 * `any-signed-in` a Cursor, Grok, Pi or OpenCode session's first message goes to
 * whichever of those two this machine is signed in to, and a Codex or Claude
 * session's goes to the other one if its own login cannot produce a title. The
 * other two choices never cross to a second vendor; a session with no generator
 * keeps a title cut from its first message.
 */
export const SESSION_TITLE_GENERATION_POLICIES = ["any-signed-in", "own-platform", "off"] as const;

export type SessionTitleGenerationPolicy = (typeof SESSION_TITLE_GENERATION_POLICIES)[number];

export const DEFAULT_SESSION_TITLE_GENERATION_POLICY: SessionTitleGenerationPolicy =
  "any-signed-in";

export function isSessionTitleGenerationPolicy(
  value: unknown,
): value is SessionTitleGenerationPolicy {
  return (SESSION_TITLE_GENERATION_POLICIES as readonly unknown[]).includes(value);
}

export function resolveSessionTitleGenerationPolicy(value: unknown): SessionTitleGenerationPolicy {
  if (value === undefined) return DEFAULT_SESSION_TITLE_GENERATION_POLICY;
  return isSessionTitleGenerationPolicy(value) ? value : "off";
}
