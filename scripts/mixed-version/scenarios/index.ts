/**
 * Every scenario module the mixed-version runner runs, in order. Add a
 * domain's module here (see `../scenario.ts`, "Adding a module").
 */
import type { ScenarioModule } from "../scenario.ts";
import agentServers from "./agent-servers.ts";
import claudeTmux from "./claude-tmux.ts";
import coordinator from "./coordinator.ts";
import design from "./design.ts";
import docker from "./docker.ts";
import environments from "./environments.ts";
import files from "./files.ts";
import git from "./git.ts";
import graphs from "./graphs.ts";
import nativeSessions from "./native-sessions.ts";
import nodeFiles from "./node-files.ts";
import nodeMail from "./node-mail.ts";
import previews from "./previews.ts";
import nodes from "./nodes.ts";
import pullRequests from "./pull-requests.ts";
import terminals from "./terminals.ts";
import ticketSync from "./ticket-sync.ts";
import transcriptArtifacts from "./transcript-artifacts.ts";
import webAnnotations from "./web-annotations.ts";
import system from "./system.ts";
import config from "./config.ts";
import projects from "./projects.ts";
import kanban from "./kanban.ts";
import accounts from "./accounts.ts";
import mcp from "./mcp.ts";
import agentMail from "./agent-mail.ts";

export const SCENARIOS: readonly ScenarioModule[] = [
  nodeMail,
  ticketSync,
  nodeFiles,
  terminals,
  files,
  claudeTmux,
  nativeSessions,
  previews,
  transcriptArtifacts,
  nodes,
  coordinator,
  agentServers,
  system,
  design,
  webAnnotations,
  environments,
  docker,
  graphs,
  git,
  pullRequests,
  projects,
  config,
  kanban,
  accounts,
  mcp,
  agentMail,
];
