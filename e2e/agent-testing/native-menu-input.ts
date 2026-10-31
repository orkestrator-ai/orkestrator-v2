import { execFileSync, spawnSync } from "node:child_process";

type NativeWindow = { id: string; title: string };

// Only called by the opt-in test on an isolated desktop. Every target comes
// from the Electron process we launched, never a title shared with production.
function powershell(script: string): string {
  script = "$ErrorActionPreference = 'Stop'\n" + script;
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
}

export function nativeMenuWindows(pid: number): NativeWindow[] {
  if (process.platform === "win32") {
    const result = powershell(`
      Add-Type -AssemblyName UIAutomationClient
      $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
      $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $condition)
      @($windows | ForEach-Object {
        @{ id = [string]$_.Current.NativeWindowHandle; title = $_.Current.Name }
      }) | ConvertTo-Json -Compress
    `);
    return result ? [JSON.parse(result)].flat() : [];
  }
  const result = spawnSync("xdotool", ["search", "--onlyvisible", "--pid", String(pid)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((id) => {
      const name = spawnSync("xdotool", ["getwindowname", id], {
        encoding: "utf8",
        timeout: 10_000,
      });
      if (name.error) throw name.error;
      // A closing menu popup can be destroyed between search and this read.
      if (name.status !== 0 && name.stderr.includes("BadWindow")) return [];
      if (name.status !== 0) throw new Error(name.stderr);
      return [{ id, title: name.stdout.trim() }];
    });
}

/** Bring the owned window to the foreground, then run `input` against it. */
function nativeMenuInput(window: NativeWindow, linux: string[], windows: string): void {
  if (!/^\d+$/.test(window.id)) throw new Error("Invalid owned native window handle");
  if (process.platform === "win32") {
    powershell(`
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type @'
      using System;
      using System.Runtime.InteropServices;
      public class MenuInput {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
      }
'@
      [void][MenuInput]::SetForegroundWindow([IntPtr]${window.id})
      if ([MenuInput]::GetForegroundWindow() -ne [IntPtr]${window.id}) {
        throw 'The owned Electron window did not gain native focus'
      }
      ${windows}
    `);
    return;
  }
  execFileSync("xdotool", ["windowfocus", "--sync", window.id, ...linux], {
    timeout: 10_000,
  });
}

/** Give the owned window native focus, as a window manager would. */
export function nativeMenuFocus(window: NativeWindow): void {
  nativeMenuInput(window, [], "");
}

export function nativeMenuKeys(window: NativeWindow, linux: string[], windows: string): void {
  nativeMenuInput(
    window,
    ["key", "--clearmodifiers", ...linux],
    `[System.Windows.Forms.SendKeys]::SendWait('${windows}')`,
  );
}

/**
 * Press and release Alt alone, which Electron's Windows and Linux menu bar
 * takes as a request for keyboard focus. SendKeys cannot send a lone Alt.
 */
export function nativeMenuAlt(window: NativeWindow): void {
  nativeMenuInput(
    window,
    ["key", "--clearmodifiers", "Alt_L"],
    `[MenuInput]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [MenuInput]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)`,
  );
}

export function nativeMenuScreenshot(window: NativeWindow): Buffer {
  if (!/^\d+$/.test(window.id)) throw new Error("Invalid owned native window handle");
  if (process.platform !== "win32") {
    return execFileSync("import", ["-window", window.id, "png:-"], {
      timeout: 10_000,
    });
  }
  const screenshot = powershell(`
    Add-Type -AssemblyName System.Drawing
    Add-Type @'
    using System;
    using System.Runtime.InteropServices;
    public class MenuCapture {
      public struct Rect { public int Left, Top, Right, Bottom; }
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    }
'@
    $rect = New-Object MenuCapture+Rect
    if (-not [MenuCapture]::GetWindowRect([IntPtr]${window.id}, [ref]$rect)) { throw 'No owned window bounds' }
    $bitmap = [System.Drawing.Bitmap]::new(($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [Convert]::ToBase64String($stream.ToArray())
    $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
  `);
  return Buffer.from(screenshot, "base64");
}
