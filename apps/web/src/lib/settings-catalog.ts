import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import { COMMAND_NODE_SECTIONS } from "./settings-catalog/scope";
import { SETTINGS_SECTION_LABELS } from "./settings-catalog/sections";

/**
 * One catalogue of the Settings destinations a user can name: the section
 * label the Settings menu shows, the curated aliases a search matches, and
 * the experimental flag a section exists behind. Settings' own menu
 * (`SettingsPage`) and the ⌘K palette's settings results both read it, so a
 * renamed or gated section changes in one place.
 *
 * Aliases name what a section contains (its headings and common synonyms),
 * never a setting's value: nothing sensitive belongs in a search catalogue.
 */
export interface GlobalSettingsCatalogEntry {
  label: string;
  aliases: readonly string[];
  /** The section exists only while this experimental flag is on. */
  gate?: "experimentalScheduling" | "experimentalSelfImprovement";
}

export const GLOBAL_SETTINGS_CATALOG: Readonly<
  Record<GlobalSettingsSection, GlobalSettingsCatalogEntry>
> = {
  general: {
    label: SETTINGS_SECTION_LABELS["general"],
    aliases: ["preferences", "preferred editor", "editor", "environment files", "options"],
  },
  "version-control": {
    label: SETTINGS_SECTION_LABELS["version-control"],
    aliases: ["git", "github", "github token", "auto-merge", "pull requests"],
  },
  machines: {
    label: SETTINGS_SECTION_LABELS["machines"],
    aliases: ["federation", "nodes", "remote machines", "updates", "connections"],
  },
  "disk-usage": {
    label: SETTINGS_SECTION_LABELS["disk-usage"],
    aliases: ["storage", "space", "cleanup"],
  },
  usage: {
    label: SETTINGS_SECTION_LABELS["usage"],
    aliases: ["cost", "tokens", "spend", "billing"],
  },
  defaults: {
    label: SETTINGS_SECTION_LABELS["defaults"],
    aliases: ["default agent", "default model", "new environment defaults"],
  },
  platforms: {
    label: SETTINGS_SECTION_LABELS["platforms"],
    aliases: ["agents", "agent platforms", "providers"],
  },
  coordinator: {
    label: SETTINGS_SECTION_LABELS["coordinator"],
    aliases: ["safety level", "orchestration"],
  },
  review: {
    label: SETTINGS_SECTION_LABELS["review"],
    aliases: ["code review", "multi review", "reviewers"],
  },
  claude: {
    label: SETTINGS_SECTION_LABELS["claude"],
    aliases: ["anthropic", "claude code", "api key"],
  },
  codex: { label: SETTINGS_SECTION_LABELS["codex"], aliases: ["openai", "chatgpt"] },
  cursor: { label: SETTINGS_SECTION_LABELS["cursor"], aliases: ["cursor api key"] },
  grok: { label: SETTINGS_SECTION_LABELS["grok"], aliases: ["xai"] },
  opencode: { label: SETTINGS_SECTION_LABELS["opencode"], aliases: ["zen", "model providers"] },
  pi: { label: SETTINGS_SECTION_LABELS["pi"], aliases: ["pi agent", "thinking level"] },
  antigravity: {
    label: SETTINGS_SECTION_LABELS["antigravity"],
    aliases: ["agy", "google antigravity", "gemini"],
  },
  capabilities: {
    label: SETTINGS_SECTION_LABELS["capabilities"],
    aliases: ["capability packages", "toolkits", "agent resources"],
  },
  skills: {
    label: SETTINGS_SECTION_LABELS["skills"],
    aliases: ["plugins", "skills", "extensions"],
  },
  terminal: { label: SETTINGS_SECTION_LABELS["terminal"], aliases: ["shell", "font", "xterm"] },
  network: {
    label: SETTINGS_SECTION_LABELS["network"],
    aliases: ["whitelist", "allowlist", "firewall", "allowed domains", "egress"],
  },
  "web-client": {
    label: SETTINGS_SECTION_LABELS["web-client"],
    aliases: ["browser access", "gateway", "remote access"],
  },
  previews: {
    label: SETTINGS_SECTION_LABELS["previews"],
    aliases: ["preview", "preview services", "web service", "dev server", "ports"],
  },
  "mcp-servers": {
    label: SETTINGS_SECTION_LABELS["mcp-servers"],
    aliases: ["mcp", "tools", "servers"],
  },
  mcp: { label: SETTINGS_SECTION_LABELS["mcp"], aliases: ["mcp control", "orkestrator mcp"] },
  messaging: {
    label: SETTINGS_SECTION_LABELS["messaging"],
    aliases: ["agent mail", "mailbox", "mail"],
  },
  schedules: {
    label: SETTINGS_SECTION_LABELS["schedules"],
    aliases: ["scheduled jobs", "cron", "timers"],
    gate: "experimentalScheduling",
  },
  "self-improvement": {
    label: SETTINGS_SECTION_LABELS["self-improvement"],
    aliases: ["learning", "improvement"],
    gate: "experimentalSelfImprovement",
  },
  permissions: {
    label: SETTINGS_SECTION_LABELS["permissions"],
    aliases: ["approvals", "permission rules", "allow"],
  },
  credentials: {
    label: SETTINGS_SECTION_LABELS["credentials"],
    aliases: ["secrets", "api keys", "tokens", "grants"],
  },
  sounds: {
    label: SETTINGS_SECTION_LABELS["sounds"],
    aliases: ["notifications", "audio", "alerts"],
  },
  docker: { label: SETTINGS_SECTION_LABELS["docker"], aliases: ["containers", "images"] },
  container: {
    label: SETTINGS_SECTION_LABELS["container"],
    aliases: ["container resources", "memory", "cpu", "image"],
  },
  experimental: {
    label: SETTINGS_SECTION_LABELS["experimental"],
    aliases: ["labs", "beta", "feature flags"],
  },
  debug: {
    label: SETTINGS_SECTION_LABELS["debug"],
    aliases: ["logs", "log detail", "diagnostics", "app version"],
  },
};

/** The section's label in Settings' own menu. */
export function globalSettingsLabel(section: GlobalSettingsSection): string {
  return GLOBAL_SETTINGS_CATALOG[section].label;
}

/** Whether Settings shows `section` under the user's experimental flags. */
export function isGlobalSettingsSectionEnabled(
  section: GlobalSettingsSection,
  flags: { experimentalScheduling?: boolean; experimentalSelfImprovement?: boolean },
): boolean {
  const gate = GLOBAL_SETTINGS_CATALOG[section].gate;
  return gate === undefined || flags[gate] === true;
}

export function isCommandNodeSettingsSection(section: GlobalSettingsSection | ""): boolean {
  return COMMAND_NODE_SECTIONS.has(section);
}
