import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * The service-manager units `orkestrator service install` writes: a launchd
 * LaunchAgent on macOS and a systemd user unit on Linux. Both run the stable
 * launcher copy with the data directory as its only argument and restart it
 * whenever it exits.
 */

export interface ServiceUnit {
  manager: "launchd" | "systemd";
  /** launchd label or systemd unit name. */
  name: string;
  file: string;
  contents: string;
}

/** A second data directory gets its own unit, named by a digest of its path. */
function suffix(dataDir: string, defaultDataDir: string): string {
  if (path.resolve(dataDir) === path.resolve(defaultDataDir)) return "";
  return `-${createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 8)}`;
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** systemd quoting for one ExecStart word. */
function systemdWord(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function serviceUnit(options: {
  platform: NodeJS.Platform;
  dataDir: string;
  defaultDataDir: string;
  bun: string;
  launcher: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
  home?: string;
}): ServiceUnit {
  const home = options.home ?? os.homedir();
  const tag = suffix(options.dataDir, options.defaultDataDir);
  const pathValue = options.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  if (options.platform === "darwin") {
    const name = `ai.orkestrator.backend${tag}`;
    const args = [options.bun, options.launcher, options.dataDir]
      .map((arg) => `    <string>${xml(arg)}</string>`)
      .join("\n");
    return {
      manager: "launchd",
      name,
      file: path.join(home, "Library", "LaunchAgents", `${name}.plist`),
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(name)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(options.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.logFile)}</string>
</dict>
</plist>
`,
    };
  }
  const name = `orkestrator-backend${tag}.service`;
  const configHome = options.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  // systemd does not inherit the installing shell's environment. Keep the
  // backend's default-directory classification consistent with the installer.
  const xdgEnvironment =
    options.env.XDG_CONFIG_HOME === undefined
      ? ""
      : `Environment=${systemdWord(`XDG_CONFIG_HOME=${options.env.XDG_CONFIG_HOME}`)}\n`;
  return {
    manager: "systemd",
    name,
    file: path.join(configHome, "systemd", "user", name),
    contents: `[Unit]
Description=Orkestrator backend (${options.dataDir})
After=network-online.target

[Service]
Type=simple
ExecStart=${[options.bun, options.launcher, options.dataDir].map(systemdWord).join(" ")}
Environment=${systemdWord(`PATH=${pathValue}`)}
Environment=NODE_ENV=production
${xdgEnvironment}Restart=always
RestartSec=10
StandardOutput=append:${options.logFile}
StandardError=append:${options.logFile}

[Install]
WantedBy=default.target
`,
  };
}

/** The commands that load, unload and inspect a unit. */
export function serviceManagerCommands(
  unit: Pick<ServiceUnit, "manager" | "name" | "file">,
  uid: number = process.getuid?.() ?? 0,
): { load: string[][]; unload: string[][]; status: string[] } {
  if (unit.manager === "launchd") {
    const domain = `gui/${uid}`;
    return {
      load: [
        ["launchctl", "bootout", `${domain}/${unit.name}`],
        ["launchctl", "bootstrap", domain, unit.file],
      ],
      unload: [["launchctl", "bootout", `${domain}/${unit.name}`]],
      status: ["launchctl", "print", `${domain}/${unit.name}`],
    };
  }
  return {
    load: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit.name],
      ["systemctl", "--user", "restart", unit.name],
    ],
    unload: [
      ["systemctl", "--user", "disable", "--now", unit.name],
      ["systemctl", "--user", "daemon-reload"],
    ],
    status: ["systemctl", "--user", "is-active", unit.name],
  };
}
