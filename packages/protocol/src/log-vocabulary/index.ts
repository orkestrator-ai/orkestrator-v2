import { DESKTOP_LOG_AREAS } from "./desktop.js";
import { GATEWAY_LOG_AREAS } from "./gateway.js";
import { LOGGING_LOG_AREAS } from "./logging.js";
import { PREVIEW_LOG_AREAS } from "./preview.js";
import { UPDATER_LOG_AREAS } from "./updater.js";

export type { LogAreaSpec } from "./define.js";

/**
 * Every area and event the logger accepts. Each domain owns one file here, so
 * adding an event touches only that domain's list and adding a domain adds two
 * lines below. `log-vocabulary.test.ts` fails on an unregistered file, an area
 * two files claim, or a name outside the grammar.
 */
export const LOG_VOCABULARY = {
  ...DESKTOP_LOG_AREAS,
  ...GATEWAY_LOG_AREAS,
  ...LOGGING_LOG_AREAS,
  ...PREVIEW_LOG_AREAS,
  ...UPDATER_LOG_AREAS,
} as const;
