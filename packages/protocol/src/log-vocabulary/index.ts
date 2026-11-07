import { AGENT_MAIL_LOG_AREAS } from "./agent-mail.js";
import { BACKEND_LOG_AREAS } from "./backend.js";
import { BRIDGE_LOG_AREAS } from "./bridge.js";
import { CONTRACT_LOG_AREAS } from "./contract.js";
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
import { STORAGE_LOG_AREAS } from "./storage.js";
import { BUILD_PIPELINE_LOG_AREAS } from "./build-pipeline.js";
import { AGENT_BRANCH_LOG_AREAS } from "./agent-branch.js";
import { CHANGE_TRACKING_LOG_AREAS } from "./change-tracking.js";
import { COORDINATOR_LOG_AREAS } from "./coordinator.js";
import { REVIEW_LOG_AREAS } from "./review.js";
import { PUBLIC_API_LOG_AREAS } from "./public-api.js";
import { AGENT_ACCOUNTS_LOG_AREAS } from "./agent-accounts.js";
import { DOCKER_LOG_AREAS } from "./docker.js";
import { MCP_LOG_AREAS } from "./mcp.js";
import { DESIGN_LOG_AREAS } from "./design.js";
import { GRAPH_LOG_AREAS } from "./graph.js";
import { NODES_LOG_AREAS } from "./nodes.js";
import { LINEAR_LOG_AREAS } from "./linear.js";
import { USAGE_HISTORY_LOG_AREAS } from "./usage-history.js";
import { FEATURE_LOG_AREAS } from "./feature.js";
import { HOST_LOG_AREAS } from "./host.js";
import { TRANSCRIPT_ARTIFACTS_LOG_AREAS } from "./transcript-artifacts.js";
import { SCHEDULER_LOG_AREAS } from "./scheduler.js";
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

export type {
  EssentialFieldKind,
  EssentialLogEvent,
  LogAreaSpec,
  LogEventSpec,
  ThrottleLogEvent,
} from "./define.js";
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
  ...CONTRACT_LOG_AREAS,
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
  ...STORAGE_LOG_AREAS,
  ...BUILD_PIPELINE_LOG_AREAS,
  ...AGENT_BRANCH_LOG_AREAS,
  ...CHANGE_TRACKING_LOG_AREAS,
  ...COORDINATOR_LOG_AREAS,
  ...REVIEW_LOG_AREAS,
  ...PUBLIC_API_LOG_AREAS,
  ...AGENT_ACCOUNTS_LOG_AREAS,
  ...DOCKER_LOG_AREAS,
  ...MCP_LOG_AREAS,
  ...DESIGN_LOG_AREAS,
  ...GRAPH_LOG_AREAS,
  ...NODES_LOG_AREAS,
  ...LINEAR_LOG_AREAS,
  ...USAGE_HISTORY_LOG_AREAS,
  ...FEATURE_LOG_AREAS,
  ...HOST_LOG_AREAS,
  ...TRANSCRIPT_ARTIFACTS_LOG_AREAS,
  ...SCHEDULER_LOG_AREAS,
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
