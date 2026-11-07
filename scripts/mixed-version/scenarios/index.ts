/**
 * Every scenario module the mixed-version runner runs, in order. Add a
 * domain's module here (see `../scenario.ts`, "Adding a module").
 */
import type { ScenarioModule } from "../scenario.ts";
import design from "./design.ts";
import nativeSessions from "./native-sessions.ts";
import nodeFiles from "./node-files.ts";
import nodeMail from "./node-mail.ts";
import previews from "./previews.ts";
import ticketSync from "./ticket-sync.ts";
import transcriptArtifacts from "./transcript-artifacts.ts";

export const SCENARIOS: readonly ScenarioModule[] = [
  nodeMail,
  ticketSync,
  nodeFiles,
  nativeSessions,
  previews,
  transcriptArtifacts,
  design,
];
