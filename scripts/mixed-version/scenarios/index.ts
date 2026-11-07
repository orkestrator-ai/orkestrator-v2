/**
 * Every scenario module the mixed-version runner runs, in order. Add a
 * domain's module here (see `../scenario.ts`, "Adding a module").
 */
import type { ScenarioModule } from "../scenario.ts";
import nativeSessions from "./native-sessions.ts";
import nodeFiles from "./node-files.ts";
import nodeMail from "./node-mail.ts";
import ticketSync from "./ticket-sync.ts";

export const SCENARIOS: readonly ScenarioModule[] = [
  nodeMail,
  ticketSync,
  nodeFiles,
  nativeSessions,
];
