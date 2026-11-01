import { AGENT_MAIL_LOG_AREAS } from "./agent-mail.js";
import { BACKEND_LOG_AREAS } from "./backend.js";
import { DESKTOP_LOG_AREAS } from "./desktop.js";
import { ENVIRONMENT_LOG_AREAS } from "./environment.js";
import { GATEWAY_LOG_AREAS } from "./gateway.js";
import { LOCAL_SERVER_LOG_AREAS } from "./local-server.js";
import { LOGGING_LOG_AREAS } from "./logging.js";
import { NATIVE_AGENT_LOG_AREAS } from "./native-agent.js";
import { PREVIEW_LOG_AREAS } from "./preview.js";
import { TERMINAL_LOG_AREAS } from "./terminal.js";
import { TMUX_LOG_AREAS } from "./tmux.js";
import { UPDATER_LOG_AREAS } from "./updater.js";
import { WEB_ANNOTATIONS_LOG_AREAS } from "./web-annotations.js";

export type { LogAreaSpec, ThrottleLogEvent } from "./define.js";

/**
 * Every area and event the logger accepts. Each domain owns one file here, so
 * adding an event touches only that domain's list and adding a domain adds two
 * lines below. `log-vocabulary.test.ts` fails on an unregistered file, an area
 * two files claim, or a name outside the grammar.
 */
export const LOG_VOCABULARY = {
  ...AGENT_MAIL_LOG_AREAS,
  ...BACKEND_LOG_AREAS,
  ...DESKTOP_LOG_AREAS,
  ...ENVIRONMENT_LOG_AREAS,
  ...GATEWAY_LOG_AREAS,
  ...LOCAL_SERVER_LOG_AREAS,
  ...LOGGING_LOG_AREAS,
  ...NATIVE_AGENT_LOG_AREAS,
  ...PREVIEW_LOG_AREAS,
  ...TERMINAL_LOG_AREAS,
  ...TMUX_LOG_AREAS,
  ...UPDATER_LOG_AREAS,
  ...WEB_ANNOTATIONS_LOG_AREAS,
} as const;
