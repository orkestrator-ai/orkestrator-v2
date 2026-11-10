// Shared by the Docker spec and lifecycle tests. No processes run at import time.
const FAKE_API_PORT = 47_123;
const FAKE_API_REPLY_DELAY_MS = 3_000;
const FAKE_API_SCRIPT = "/tmp/orkestrator-qa-fake-claude-api.ts";
const SETTINGS_BACKUP = "/tmp/orkestrator-qa-claude-settings.json";

type InstallerDependencies = {
  asNode: (script: string, input?: string) => unknown;
  startServer: (args: string[]) => unknown;
  stopServer: () => void;
  waitUntilReady: () => Promise<void>;
  source: string;
  /**
   * What follows the script on the server's command line. Defaults to the
   * signal spec's 3 s reply delay; the Multi Review fake passes `--log`.
   */
  serverArgs?: string[];
};

/** Preserve the first backup across interrupted installs; undo is repeatable. */
export async function installFakeClaudeApiFixture({
  asNode,
  startServer,
  stopServer,
  waitUntilReady,
  source,
  serverArgs = [
    // A turn as long as a short real one, so its `working` edge is visible.
    "--reply-delay-ms",
    String(FAKE_API_REPLY_DELAY_MS),
  ],
}: InstallerDependencies): Promise<() => void> {
  const undo = () => {
    stopServer();
    asNode(
      `set -e; if [ -f ${SETTINGS_BACKUP} ]; then cat ${SETTINGS_BACKUP} > "$HOME/.claude/settings.json"; rm -f ${SETTINGS_BACKUP}; fi; rm -f ${FAKE_API_SCRIPT} "$HOME/.claude/settings.json.qa"`,
    );
  };
  try {
    asNode(`cat > ${FAKE_API_SCRIPT}`, source);
    startServer(["bun", FAKE_API_SCRIPT, "--port", String(FAKE_API_PORT), ...serverArgs]);
    const env = JSON.stringify({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_API_PORT}`,
      ANTHROPIC_AUTH_TOKEN: "orkestrator-qa-fixture",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    // Keep the image's hooks and consent: merge, never replace.
    asNode(
      `set -e; s="$HOME/.claude/settings.json"; if [ ! -f ${SETTINGS_BACKUP} ]; then cp "$s" ${SETTINGS_BACKUP}; fi; jq --argjson env '${env}' '.env = ((.env // {}) + $env)' ${SETTINGS_BACKUP} > "$s.qa"; cat "$s.qa" > "$s"; rm -f "$s.qa"`,
    );
    await waitUntilReady();
  } catch (error) {
    undo();
    throw error;
  }
  return undo;
}
