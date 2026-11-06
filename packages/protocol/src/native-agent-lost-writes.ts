/**
 * The transcript advisory a bridge appends when its provider reports that part
 * of the conversation was not saved (Claude's `session_writes_lost`, a Pi
 * session-file write that failed and was rolled back).
 *
 * One fixed text for every provider, so a lost write reads the same whichever
 * engine is behind the tab, and never the provider's own error, which can name
 * paths. Bridges show it as a `status` part with `warning` severity, alone on
 * an `assistant` row whose `content` is empty (a `system` row renders only its
 * `content`, without the severity), once per session, and keep it across a
 * reload: the user who resumes the conversation later is the one it is for.
 */
export const NATIVE_AGENT_LOST_WRITE_ADVISORY =
  "This conversation could not be fully saved. Resuming it may miss recent messages.";
