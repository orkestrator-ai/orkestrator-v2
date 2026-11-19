import type { GlobalSettingsSection } from "@/lib/settings-navigation";

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
    label: "General",
    aliases: ["preferences", "preferred editor", "editor", "environment files", "options"],
  },
  "version-control": {
    label: "Version control",
    aliases: ["git", "github", "github token", "auto-merge", "pull requests"],
  },
  machines: {
    label: "Machines",
    aliases: ["federation", "nodes", "remote machines", "updates", "connections"],
  },
  "disk-usage": { label: "Disk usage", aliases: ["storage", "space", "cleanup"] },
  usage: { label: "Usage", aliases: ["cost", "tokens", "spend", "billing"] },
  defaults: {
    label: "Defaults",
    aliases: ["default agent", "default model", "new environment defaults"],
  },
  platforms: { label: "Platforms", aliases: ["agents", "agent platforms", "providers"] },
  coordinator: { label: "Coordinator", aliases: ["safety level", "orchestration"] },
  review: { label: "Review", aliases: ["code review", "multi review", "reviewers"] },
  claude: { label: "Claude", aliases: ["anthropic", "claude code", "api key"] },
  codex: { label: "Codex", aliases: ["openai", "chatgpt"] },
  cursor: { label: "Cursor", aliases: ["cursor api key"] },
  grok: { label: "Grok", aliases: ["xai"] },
  opencode: { label: "OpenCode", aliases: ["zen", "model providers"] },
  pi: { label: "Pi", aliases: ["pi agent", "thinking level"] },
  skills: { label: "Skills and plugins", aliases: ["plugins", "skills", "extensions"] },
  terminal: { label: "Terminal", aliases: ["shell", "font", "xterm"] },
  network: {
    label: "Network",
    aliases: ["whitelist", "allowlist", "firewall", "allowed domains", "egress"],
  },
  "web-client": { label: "Web client", aliases: ["browser access", "gateway", "remote access"] },
  previews: {
    label: "Browser previews",
    aliases: ["preview", "preview services", "web service", "dev server", "ports"],
  },
  "mcp-servers": { label: "MCP servers", aliases: ["mcp", "tools", "servers"] },
  mcp: { label: "Control MCP", aliases: ["mcp control", "orkestrator mcp"] },
  messaging: { label: "Messaging", aliases: ["agent mail", "mailbox", "mail"] },
  schedules: {
    label: "Schedules",
    aliases: ["scheduled jobs", "cron", "timers"],
    gate: "experimentalScheduling",
  },
  "self-improvement": {
    label: "Self-improvement",
    aliases: ["learning", "improvement"],
    gate: "experimentalSelfImprovement",
  },
  permissions: { label: "Permissions", aliases: ["approvals", "permission rules", "allow"] },
  credentials: { label: "Credentials", aliases: ["secrets", "api keys", "tokens", "grants"] },
  sounds: { label: "Sounds", aliases: ["notifications", "audio", "alerts"] },
  docker: { label: "Docker", aliases: ["containers", "images"] },
  container: {
    label: "Container",
    aliases: ["container resources", "memory", "cpu", "image"],
  },
  experimental: { label: "Experimental", aliases: ["labs", "beta", "feature flags"] },
  debug: { label: "Debug", aliases: ["logs", "log detail", "diagnostics", "app version"] },
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
