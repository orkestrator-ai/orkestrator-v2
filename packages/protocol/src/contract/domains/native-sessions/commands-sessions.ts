/**
 * `native-sessions` commands for terminal tab sessions, their scrollback
 * buffers, the environment's pane layout, and the host actions a tab opens
 * (browser, editor, file manager, DNS checks). Registered by the backend's
 * `commands-registry-sessions.ts`. The argument rules are those of
 * `commands-agent.ts`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mutableArray } from "../../model-schema.js";
import { nativeSessionsDomain } from "./domain.js";
import {
  conditionalSnapshotOf,
  DomainResolutionSchema,
  PaneLayoutSchema,
  TerminalSessionSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** The keys of a conditional resource read (`conditionalManifestSnapshot`). */
const conditional = {
  knownManifestGeneration: optionalUnknown,
  knownResourceRevision: optionalUnknown,
};

const Sessions = Schema.Array(TerminalSessionSchema);
const NullablePaneLayout = Schema.NullOr(PaneLayoutSchema);

/** Opens a URL in the host's browser. */
export const openInBrowserCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "open_in_browser",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ url: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Shows a path in the host's file manager. */
export const revealInFileManagerCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "reveal_in_file_manager",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ path: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Opens a container's workspace in VS Code or Cursor on the host. */
export const openInEditorCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "open_in_editor",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ containerId: Schema.String, editor: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Opens a host path in VS Code or Cursor. */
export const openLocalInEditorCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "open_local_in_editor",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ path: Schema.String, editor: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Resolves allow-list domains on the host. `domains` keeps its strings, as before. */
export const testDomainResolutionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "test_domain_resolution",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ domains: optionalUnknown }),
  result: Schema.Array(DomainResolutionSchema),
  critical: [],
});

/** Records a terminal tab's session. */
export const createSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "create_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    containerId: Schema.String,
    tabId: Schema.String,
    sessionType: Schema.String,
  }),
  result: TerminalSessionSchema,
  critical: [],
});

/** One terminal session, or `null`. */
export const getSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_session",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ sessionId: Schema.String }),
  result: Schema.NullOr(TerminalSessionSchema),
  critical: [],
});

/** The environment's terminal sessions, or the conditional answer when the caller holds them. */
export const getSessionsByEnvironmentCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_sessions_by_environment",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, ...conditional }),
  result: Schema.Union([Sessions, conditionalSnapshotOf(Sessions)]),
  critical: [],
});

export const updateSessionStatusCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "update_session_status",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: Schema.String, status: Schema.String }),
  result: TerminalSessionSchema,
  critical: [],
});

export const updateSessionActivityCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "update_session_activity",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: Schema.String }),
  result: TerminalSessionSchema,
  critical: [],
});

export const deleteSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "delete_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Removes every terminal session of an environment; answers the removed ids. */
export const deleteSessionsByEnvironmentCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "delete_sessions_by_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: mutableArray(Schema.String),
  critical: [],
});

/** Renames a session; a non-string `name` clears it, as before. */
export const renameSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "rename_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: Schema.String, name: optionalUnknown }),
  result: TerminalSessionSchema,
  critical: [],
});

export const disconnectEnvironmentSessionsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "disconnect_environment_sessions",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: Sessions,
  critical: [],
});

export const saveSessionBufferCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "save_session_buffer",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: Schema.String, buffer: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const loadSessionBufferCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "load_session_buffer",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionId: Schema.String }),
  result: Schema.NullOr(Schema.String),
  critical: [],
});

/** Disconnects the sessions of a stopped container; `containerRunning` reads leniently. */
export const syncSessionsWithContainerCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "sync_sessions_with_container",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String, containerRunning: optionalUnknown }),
  result: Sessions,
  critical: [],
});

/** Reorders an environment's sessions; `sessionIds` keeps its strings, as before. */
export const reorderSessionsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "reorder_sessions",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String, sessionIds: optionalUnknown }),
  result: Sessions,
  critical: [],
});

/** The environment's pane layout, or the conditional answer. */
export const getPaneLayoutCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_pane_layout",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, ...conditional }),
  result: Schema.Union([NullablePaneLayout, conditionalSnapshotOf(NullablePaneLayout)]),
  critical: [],
});

/** Replaces the pane layout at a revision (compare and swap). */
export const savePaneLayoutCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "save_pane_layout",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    layout: optionalUnknown,
    // Checked after the layout, with the handler's message.
    expectedRevision: optionalUnknown,
  }),
  result: PaneLayoutSchema,
  critical: [],
});

/** Merges a layout change into the stored layout (three-way). */
export const applyPaneLayoutIntentCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "apply_pane_layout_intent",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    baseLayout: optionalUnknown,
    desiredLayout: optionalUnknown,
    selectionIntent: optionalUnknown,
  }),
  result: PaneLayoutSchema,
  critical: [],
});

/** Deletes the pane layout, at a revision when one is given. */
export const deletePaneLayoutCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "delete_pane_layout",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    expectedRevision: Schema.optionalKey(Schema.Finite),
  }),
  result: Schema.Void,
  // expectedRevision: ignoring it would delete a layout another client changed.
  critical: ["expectedRevision"],
});

export const SESSION_COMMANDS = [
  openInBrowserCommand,
  revealInFileManagerCommand,
  openInEditorCommand,
  openLocalInEditorCommand,
  testDomainResolutionCommand,
  createSessionCommand,
  getSessionCommand,
  getSessionsByEnvironmentCommand,
  updateSessionStatusCommand,
  updateSessionActivityCommand,
  deleteSessionCommand,
  deleteSessionsByEnvironmentCommand,
  renameSessionCommand,
  disconnectEnvironmentSessionsCommand,
  saveSessionBufferCommand,
  loadSessionBufferCommand,
  syncSessionsWithContainerCommand,
  reorderSessionsCommand,
  getPaneLayoutCommand,
  savePaneLayoutCommand,
  applyPaneLayoutIntentCommand,
  deletePaneLayoutCommand,
] as const;
