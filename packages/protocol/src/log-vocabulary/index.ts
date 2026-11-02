import { AGENT_MAIL_LOG_AREAS } from "./agent-mail.js";
import { BACKEND_LOG_AREAS } from "./backend.js";
import { BRIDGE_LOG_AREAS } from "./bridge.js";
import { DESKTOP_LOG_AREAS } from "./desktop.js";
import { ENVIRONMENT_LOG_AREAS } from "./environment.js";
import { GATEWAY_LOG_AREAS } from "./gateway.js";
import { LOCAL_SERVER_LOG_AREAS } from "./local-server.js";
import { GIT_LOG_AREAS } from "./git.js";
import { LOGGING_LOG_AREAS } from "./logging.js";
import { MODEL_LOG_AREAS } from "./models.js";
import { NATIVE_AGENT_LOG_AREAS } from "./native-agent.js";
import { PREVIEW_LOG_AREAS } from "./preview.js";
import { RUNTIME_LOG_AREAS } from "./runtime.js";
import { TERMINAL_LOG_AREAS } from "./terminal.js";
import { TMUX_LOG_AREAS } from "./tmux.js";
import { UPDATER_LOG_AREAS } from "./updater.js";
import { WEB_ANNOTATIONS_LOG_AREAS } from "./web-annotations.js";
import { WEB_APP_LOG_AREAS } from "./web-app.js";
import { WEB_BUILD_PIPELINE_LOG_AREAS } from "./web-build-pipeline.js";
import { WEB_CHAT_LOG_AREAS } from "./web-chat.js";
import { WEB_CLAUDE_TMUX_LOG_AREAS } from "./web-claude-tmux.js";
import { WEB_DESIGN_LOG_AREAS } from "./web-design.js";
import { WEB_ENVIRONMENT_LOG_AREAS } from "./web-environment.js";
import { WEB_FILES_LOG_AREAS } from "./web-files.js";
import { WEB_GITHUB_LOG_AREAS } from "./web-github.js";
import { WEB_KANBAN_LOG_AREAS } from "./web-kanban.js";
import { WEB_PANE_LAYOUT_LOG_AREAS } from "./web-pane-layout.js";
import { WEB_SETTINGS_LOG_AREAS } from "./web-settings.js";
import { WEB_SHELL_LOG_AREAS } from "./web-shell.js";
import { WEB_SYNC_LOG_AREAS } from "./web-sync.js";

export type { LogAreaSpec, ThrottleLogEvent } from "./define.js";
export { COMMAND_FAILURE_REASONS, type CommandFailureReason } from "./command-failure-reasons.js";

/**
 * Every area and event the logger accepts. Each domain owns one file here, so
 * adding an event touches only that domain's list and adding a domain adds two
 * lines below. `log-vocabulary.test.ts` fails on an unregistered file, an area
 * two files claim, or a name outside the grammar.
 */
export const LOG_VOCABULARY = {
  ...AGENT_MAIL_LOG_AREAS,
  ...BACKEND_LOG_AREAS,
  ...BRIDGE_LOG_AREAS,
  ...DESKTOP_LOG_AREAS,
  ...ENVIRONMENT_LOG_AREAS,
  ...GATEWAY_LOG_AREAS,
  ...LOCAL_SERVER_LOG_AREAS,
  ...GIT_LOG_AREAS,
  ...LOGGING_LOG_AREAS,
  ...MODEL_LOG_AREAS,
  ...NATIVE_AGENT_LOG_AREAS,
  ...PREVIEW_LOG_AREAS,
  ...RUNTIME_LOG_AREAS,
  ...TERMINAL_LOG_AREAS,
  ...TMUX_LOG_AREAS,
  ...UPDATER_LOG_AREAS,
  ...WEB_ANNOTATIONS_LOG_AREAS,
  ...WEB_APP_LOG_AREAS,
  ...WEB_BUILD_PIPELINE_LOG_AREAS,
  ...WEB_CHAT_LOG_AREAS,
  ...WEB_CLAUDE_TMUX_LOG_AREAS,
  ...WEB_DESIGN_LOG_AREAS,
  ...WEB_ENVIRONMENT_LOG_AREAS,
  ...WEB_FILES_LOG_AREAS,
  ...WEB_GITHUB_LOG_AREAS,
  ...WEB_KANBAN_LOG_AREAS,
  ...WEB_PANE_LAYOUT_LOG_AREAS,
  ...WEB_SETTINGS_LOG_AREAS,
  ...WEB_SHELL_LOG_AREAS,
  ...WEB_SYNC_LOG_AREAS,
} as const;
