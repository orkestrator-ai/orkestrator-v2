/**
 * Service units that keep `orkestrator serve --supervised` running across
 * reboots and supervisor crashes. The supervisor does the version swap, health
 * check and rollback itself; the unit only restarts it. Both run the
 * supervisor from `<dataDir>/runtime/current`, so a successful update is
 * picked up the next time the service starts.
 */
import os from "node:os";
import path from "node:path";

export type ServiceManager = "systemd" | "launchd";

export const SYSTEMD_UNIT_NAME = "orkestrator.service";
export const LAUNCHD_LABEL = "dev.orkestrator.backend";

export type ServiceUnitOptions = {
  manager: ServiceManager;
  /** The Bun executable that runs the launcher. */
  bunPath: string;
  /** `<dataDir>/runtime/current/node_modules/orkestrator/bin/orkestrator.js`. */
  launcherPath: string;
  dataDir: string;
  /** Service flags passed through to `serve`, without `--supervised`. */
  serveArgs: readonly string[];
  home?: string;
};

export function defaultServiceManager(
  platform: NodeJS.Platform = process.platform,
): ServiceManager {
  return platform === "darwin" ? "launchd" : "systemd";
}

export function serviceUnitPath(manager: ServiceManager, home = os.homedir()): string {
  return manager === "launchd"
    ? path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

/** systemd splits ExecStart on whitespace and expands `%`, `$` and `\`. */
function systemdQuote(value: string): string {
  if (/["\\\n\r]/.test(value)) throw new Error(`Cannot quote ${JSON.stringify(value)} for systemd`);
  const escaped = value.replaceAll("%", "%%").replaceAll("$", "$$$$");
  return /[\s']/.test(escaped) ? `"${escaped}"` : escaped;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderServiceUnit(options: ServiceUnitOptions): string {
  const argv = [
    options.bunPath,
    options.launcherPath,
    "serve",
    "--supervised",
    ...options.serveArgs,
  ];
  if (options.manager === "systemd") {
    return [
      "[Unit]",
      "Description=Orkestrator backend (supervised; updates in place)",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${argv.map(systemdQuote).join(" ")}`,
      `Environment=${systemdQuote(`ORKESTRATOR_DATA_DIR=${options.dataDir}`)}`,
      // The supervisor exits 0 on a clean stop; anything else is restarted.
      "Restart=on-failure",
      "RestartSec=5",
      // SIGTERM reaches the supervisor, which drains the backend (60 s) first.
      "TimeoutStopSec=90",
      "KillMode=mixed",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }
  const logDir = path.join(options.dataDir, "logs");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>ORKESTRATOR_DATA_DIR</key>",
    `    <string>${xml(options.dataDir)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ExitTimeOut</key>",
    "  <integer>90</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(path.join(logDir, "supervisor.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(path.join(logDir, "supervisor.err.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** What to run after writing the unit; printed, never run on the user's behalf. */
export function serviceEnableCommands(manager: ServiceManager, unitPath: string): string[] {
  return manager === "systemd"
    ? ["systemctl --user daemon-reload", `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`]
    : [`launchctl bootstrap gui/$(id -u) ${unitPath}`];
}
