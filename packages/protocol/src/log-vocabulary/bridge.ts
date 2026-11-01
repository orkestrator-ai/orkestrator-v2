import { defineLogAreas } from "./define.js";

/** `bridge.diagnostics` holds one snapshot per entry; see `maxStringChars`. */
export const MAX_BRIDGE_DIAGNOSTIC_BYTES = 8192;

export const BRIDGE_LOG_AREAS = defineLogAreas({
  "bridge.diagnostics": {
    description:
      "Metadata snapshots of bridge turns and processes, written while Save Logs for Debugging is on. docs/architecture/bridge-diagnostics.md reads them.",
    // Support recipes and docs/architecture/bridge-diagnostics.md search for this.
    tag: "bridge-diagnostics",
    // A snapshot is allowlisted and bounded where it is built, so it is written whole.
    maxStringChars: MAX_BRIDGE_DIAGNOSTIC_BYTES,
    events: {
      heartbeat: "The once-a-minute snapshot of a turn or process that is still open.",
      "send-started": "A turn or process diagnostic scope began.",
      "send-resolved": "The provider accepted a dispatch.",
      "cancel-requested": "Cancellation of a turn was requested.",
      "cancel-settled": "The provider's cancel call returned or failed.",
      closed: "A diagnostic scope ended, with its final counters.",
      "snapshot-overflow": "A snapshot exceeded the bound, so only its size was written.",
      "debug-events": "A batch of allowlisted debug labels with their counts.",
      "setup-failed": "A Cursor setup step failed and swallowed its error.",
      "sdk-snapshot": "Cursor's SDK transports and executions at a boundary.",
      "sdk-snapshot-overflow": "A Cursor SDK snapshot exceeded the bound, so it was omitted.",
    },
  },
  "bridge.lifecycle": {
    description: "What every long-lived bridge does the same way: its sweep and its shutdown.",
    events: {
      "idle-sweep.failed": "An idle sweep threw; the next tick retries.",
      "shutdown.failed": "Releasing the bridge failed during shutdown; it still exits.",
    },
  },
  "bridge.acp": {
    description:
      "The ACP bridge behind Grok: its routes, sessions, saved state and change evidence.",
    events: {
      "command-change.record-failed": "A measured command change could not be recorded.",
      "evidence.record-failed": "Change evidence could not be recorded; the read loop carries on.",
      "evidence.shell-record-failed": "A shell observation could not be recorded.",
      "evidence.turn-record-failed": "Turn change evidence could not be recorded.",
      "server.listening": "The HTTP server is listening.",
      "state.composer-reset": "A saved composer state was malformed and was reset.",
      "state.discarded": "Saved bridge state could not be used and was discarded.",
      "state.persist-failed": "Saving bridge state failed; a later write retries.",
      "state.session-config-reset": "A saved session configuration was malformed and was reset.",
    },
  },
  "bridge.claude": {
    description:
      "The Claude bridge: its routes, sessions, parked interactions and the Agent SDK turn loop.",
    events: {
      "commands.read-failed": "The command catalogue read failed; the cached answer stands.",
      "context-usage.read-failed": "The detailed context usage read failed; the route falls back.",
      "dispatch.rollback-failed": "Rolling back a prompt dispatch claim failed.",
      "event-subscriber.failed": "An event subscriber threw; other subscribers still ran.",
      "http.request-failed": "An HTTP route threw; it answered 500.",
      "mcp.config-ignored": "An MCP server configuration of an unsupported shape was ignored.",
      "mcp.read-failed": "Listing MCP servers failed; the route answered 500.",
      "models.fetch-failed":
        "Reading the supported models failed; the fallback catalogue is served.",
      "models.requested": "The model catalogue route was called.",
      "models.responded": "The model catalogue route answered.",
      "parent.gone": "The backend that launched this bridge has gone; shutting down.",
      "plan-approval.responding": "Answering a parked plan approval.",
      "plan-approval.response-failed": "The plan approval route failed.",
      "plan-approval.response-received": "The route received a plan approval answer.",
      "plan-approval.result": "A parked plan approval was answered.",
      "plan-approval.wait-failed":
        "A parked plan approval ended without an answer: cancelled, timed out or closed.",
      "plan-exit.failure-overridden":
        "ExitPlanMode failed after the user approved; treated as success with a continuation re-prompt.",
      "plan-mode.record-failed": "Plan mode from a status frame could not be recorded.",
      "plan.reprompt-approved-failed": "Re-prompting after an approved plan failed.",
      "plan.reprompt-feedback-failed": "Re-prompting with plan rejection feedback failed.",
      "plugin.path-missing": "A configured plugin was skipped because its path does not exist.",
      "plugin.unsafe-path": "An installed plugin was skipped because its install path is unsafe.",
      "plugins.read-failed": "Listing plugins failed; the route answered 500.",
      "prompt.accepted": "The route accepted a prompt and answered 202.",
      "prompt.failed": "A prompt turn failed; the session reports the error.",
      "prompt.processing-failed": "A prompt accepted by the route failed while processing.",
      "prompt.received": "A prompt reached the bridge; only its length is logged.",
      "prompt.send-failed": "A prompt request failed; the route answered with an error.",
      "query.close-failed":
        "Stopping the Claude query failed while closing a tab; the close stays pending.",
      "query.failed": "A Claude query ended with an error result.",
      "question.answer-failed": "The answer-question route failed.",
      "question.answering": "Answering a parked question.",
      "question.answers-prepared": "The route prepared a question answer for the session.",
      "question.answers-received": "A parked question received its answers.",
      "question.stale":
        "An answer arrived for a question no longer pending; the route answered stale.",
      "question.wait-failed":
        "A parked question ended without an answer: cancelled, timed out or closed.",
      "runtime.ended-under-resumed-turn":
        "The Claude runtime ended while a resumed root turn was still open.",
      "server.listening": "The HTTP server is listening.",
      "server.starting": "The HTTP server is about to bind.",
      "session.compact-failed": "A requested compaction failed.",
      "session.create-failed": "Creating a session failed; the route answered with an error.",
      "session.created": "A session was created or recovered.",
      "session.delete-failed": "Deleting a session failed.",
      "session.fork-failed": "Forking a session failed.",
      "session.rename-failed": "Renaming a session failed.",
      "session.resolve-failed":
        "A session could not be found or loaded for a request; action names the request.",
      "session.rewind-failed": "Rewinding session files failed.",
      "session.task-state-hydrate-failed":
        "Hydrating session task state failed; the route answered with an error.",
      "sessions.reconcile-failed":
        "Reconciling persisted sessions failed; the sessions already known are listed.",
      "sse.aborted": "The client closed an event stream.",
      "sse.cleanup": "An event stream connection was released.",
      "sse.closed": "An event stream was closed by the bridge; the client reconnects and replays.",
      "sse.handshake-failed": "An event stream failed during its handshake; the client reconnects.",
      "sse.keepalive-failed":
        "An event stream keepalive failed, usually a client that has gone; the connection closes.",
      "sse.opened": "An event stream connection opened.",
      "sse.subscribe-requested": "A client asked to subscribe to the event stream.",
      "sse.write-failed":
        "Writing to an event stream failed; the connection closes and the client reconnects.",
      "task.candidate-bound-reached":
        "An unresolved Bash call was not tracked as a background task: the candidate bound is full.",
      "task.details-persist-failed": "Shell task details could not be saved; the task carries on.",
      "task.settling-bound-reached": "A settling task was not tracked: the settling bound is full.",
      "task.stop-failed": "Stopping a background task failed on a control channel that had closed.",
      "task.stop-route-failed": "The stop-task route failed.",
      "transcript.background-hydrate-failed":
        "Hydrating a transcript in the background failed; the next read retries.",
      "transcript.hydrate-failed":
        "Hydrating a transcript before a prompt failed; the prompt runs and a later read retries.",
    },
  },
  "bridge.codex": {
    description: "The Codex bridge: its routes, sessions and the app-server child it supervises.",
    events: {
      "account.connector-recovery-failed":
        "Recovering account connectors failed; the account answer stands.",
      "account.login-reload-failed": "Reloading the stored account login failed.",
      "account.sign-in-check-failed":
        "An account sign-in check failed; admission is left unchanged.",
      "account.usage-read-failed": "Reading account usage failed; the route answers 503.",
      "app-server.drain-expired":
        "The drain deadline expired, so app-server restarted with turns still in flight.",
      "app-server.exited": "app-server exited unexpectedly; the code and signal say how.",
      "app-server.invariant-violation": "app-server asked for something its configuration forbids.",
      "app-server.protocol-violation":
        "app-server wrote a line that is not valid protocol; it was ignored.",
      "app-server.recording": "Notification recording is on; recordings hold content.",
      "app-server.stale-reaped": "A stale app-server left by an earlier bridge was stopped.",
      "app-server.stderr": "Metadata of an app-server stderr line, never its content.",
      "app-server.stderr-suppressed":
        "app-server stderr lines beyond the budget were counted, not described.",
      "approval.cancel-failed": "Cancelling a turn after an approval answer failed.",
      "approval.present-failed": "Presenting an approval threw; it is auto-declined.",
      "approval.resolved-callback-failed": "An approval resolved callback threw.",
      "command-changes.record-failed":
        "Recording line changes for a command failed; the turn carries on.",
      "dispatch.reconcile-failed":
        "A dispatch could not be reconciled against its thread; it stays recovering.",
      "dispatch.restore-failed":
        "A journaled dispatch could not be restored after a restart; recovery retries.",
      "engine.listener-failed": "An engine event listener threw; the others still ran.",
      "engine.ready": "The app-server engine started.",
      "engine.start-failed": "The app-server engine failed to start; reported through health.",
      "engine.stop-failed":
        "Stopping the Codex engine failed during shutdown; the bridge exits anyway.",
      "generation.recovery-failed":
        "Recovering sessions after an app-server generation change failed.",
      "http.request-failed": "An HTTP route threw; it answered 500.",
      "idle-sweep.failed": "An idle sweep failed; the next one retries.",
      "interaction.present-failed": "Presenting an interaction threw; it is cancelled.",
      "interaction.resolved-callback-failed": "An interaction resolved callback threw.",
      "journal.persist-failed": "Saving the dispatch journal failed.",
      "message.publish-failed": "Publishing a message update failed.",
      "models.cache-persist-failed": "Saving the model cache failed.",
      "models.debug-read-failed": "`codex debug models` failed; another source is used.",
      "models.list-failed": "model/list failed; the cached models are served.",
      "models.refresh-failed": "A background model refresh failed; the cache stands.",
      "notification.enqueue-failed": "Queueing a notification threw.",
      "ordered-events.flush-failed": "Flushing before ordered-event reconciliation failed.",
      "ordered-events.publish-failed":
        "Publishing an ordered event failed; clients are told to rehydrate.",
      "ordered-events.reconcile-failed": "Reconciling ordered events failed.",
      "parent.gone":
        "The backend that launched this bridge has gone; stopping turns and shutting down.",
      "queue.task-failed": "A task on a per-thread queue failed.",
      "raw-log.write-failed": "Appending to the raw Codex log failed.",
      "recorder.notice":
        "The notification recorder needs attention: it is on, or was asked for without its confirmation.",
      "recorder.threw": "The notification recorder threw.",
      "recorder.write-failed": "Writing a notification recording failed; its lines were dropped.",
      "registry.persist-failed": "Saving the session registry failed; a later write retries.",
      "rollout.hydrate-failed": "A rollout could not be read to hydrate a thread.",
      "runtime-env.refresh-failed":
        "Refreshing the runtime environment failed; the last values stay.",
      "runtime-env.refreshed": "Runtime environment variables changed; names only, never values.",
      "server-request.answer-failed": "Answering a server request failed.",
      "server-request.flush-timeout": "An answer to a server request did not flush in time.",
      "server-request.handoff-failed": "Handing a server request to the router threw.",
      "session.config-apply-failed":
        "Applying session configuration failed; the route answers unavailable.",
      "sse.closed": "An event stream was closed by the bridge; the client reconnects and replays.",
      "sse.keepalive-failed": "An event stream keepalive failed.",
      "sse.observer-failed": "An event stream observer failed; it reconnects.",
      "sse.payload-serialize-failed":
        "An event payload could not be serialized; a placeholder was sent.",
      "sse.payload-snapshot-failed":
        "An event payload could not be snapshotted; a placeholder was sent.",
      "sse.subscriber-failed": "An event stream subscriber failed; it reconnects and replays.",
      "subagent.activity-load-failed":
        "Sub-agent activity could not be loaded; the transcript renders without it.",
      "thread.archive-failed": "Archiving or unarchiving a thread failed.",
      "thread.fork-failed": "thread/fork failed; the route answers 503.",
      "thread.fork-hydrate-failed": "A forked thread could not be hydrated and was closed.",
      "thread.reattach-failed": "A thread could not be re-attached.",
      "thread.rename-failed": "thread/name/set failed; the bridge title index stays authoritative.",
      "thread.turns-read-after-revert-failed": "A thread's turns could not be read after a revert.",
      "thread.turns-read-failed": "A thread's turns could not be read.",
      "thread.unsubscribe-failed":
        "thread/unsubscribe failed; the binding is kept so a retry can unsubscribe.",
      "threads.list-failed": "thread/list failed; sessions come from the rollout parser.",
      "transcript.serving-last-known":
        "A thread read failed, so the last known transcript is served.",
      "turn.capacity-retry-failed": "Retrying a turn after a capacity failure failed.",
      "turn.capacity-retry-journal-failed": "A capacity retry could not be journaled.",
      "turn.finalize-failed": "Finalizing a turn failed.",
      "turns.stopped": "Running turns were stopped because the backend went away.",
    },
  },
  "bridge.cursor": {
    description: "The Cursor bridge: its routes, sessions and saved state.",
    events: {
      "agent.archive-failed": "Archiving or unarchiving an agent failed.",
      "http.route-failed":
        "An HTTP route failed unexpectedly; its error is not logged because it can hold content.",
      "startup.closes-failed": "Finishing closes a previous process left behind failed at startup.",
      "startup.closes-incomplete":
        "Some closes a previous process left behind did not finish at startup; a retried close finishes them.",
      "state.publication-failing":
        "Saving bridge state is failing; new prompts and steers are refused until it recovers.",
      "state.publication-recovered": "Saving bridge state recovered.",
      "state.transcripts-shortened":
        "The state file reached its limit, so some sessions were saved with a shortened transcript copy.",
    },
  },
  "bridge.pi": {
    description: "The Pi bridge: its routes, sessions and saved state.",
    events: {
      "http.route-failed":
        "An HTTP route failed unexpectedly; its error is not logged because it can hold content.",
      "state.over-budget":
        "The state file stayed over budget after shedding transcripts, so the write was skipped.",
      "state.transcripts-shed":
        "The state file was over budget, so some sessions were saved without their transcript.",
    },
  },
});
