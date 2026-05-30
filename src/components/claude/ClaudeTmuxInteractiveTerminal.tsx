import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useClipboardImagePaste } from "@/hooks/useClipboardImagePaste";
import {
  createInteractiveTerminal,
  detachInteractiveTerminal,
  resizeInteractiveTerminal,
  startInteractiveTerminal,
  writeInteractiveTerminal,
} from "@/lib/claude-tmux-client";
import { escapePathForTerminalInput, handleTerminalPaste } from "@/lib/terminal-paste";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";

interface ClaudeTmuxInteractiveTerminalProps {
  tabId: string;
  environmentId?: string;
  containerId?: string | null;
  worktreePath?: string | null;
  isActive: boolean;
  className?: string;
}

export function ClaudeTmuxInteractiveTerminal({
  tabId,
  environmentId,
  containerId,
  worktreePath,
  isActive,
  className,
}: ClaudeTmuxInteractiveTerminalProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const terminalAppearance = useConfigStore(
    (state) => state.config.global.terminalAppearance,
  ) ?? DEFAULT_TERMINAL_APPEARANCE;
  const terminalScrollback = useConfigStore(
    (state) => state.config.global.terminalScrollback,
  );
  const terminalBackgroundColor = resolveTerminalBackgroundColor(
    terminalAppearance.backgroundColor,
  );

  const writeToTerminal = useCallback(async (data: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    await writeInteractiveTerminal(sessionId, data);
  }, []);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const handlePaste = useCallback(async () => {
    await handleTerminalPaste({
      containerId,
      worktreePath,
      writeToTerminal,
      focusTerminal,
      componentName: "ClaudeTmuxInteractiveTerminal",
    });
  }, [containerId, worktreePath, writeToTerminal, focusTerminal]);

  // Keep the latest paste handler in a ref so the terminal/tmux session
  // lifecycle does not depend on the handler's identity. Without this, a
  // change to containerId/worktreePath would tear down and recreate the
  // session just to refresh the key-handler closure.
  const handlePasteRef = useRef(handlePaste);
  useEffect(() => {
    handlePasteRef.current = handlePaste;
  }, [handlePaste]);

  const handleImageSaved = useCallback(
    async (filePath: string) => {
      const terminalPath = containerId ? filePath : escapePathForTerminalInput(filePath);
      await writeToTerminal(terminalPath + " ");
      focusTerminal();
    },
    [containerId, writeToTerminal, focusTerminal],
  );

  const handleImageError = useCallback((errorMessage: string) => {
    console.error("[ClaudeTmuxInteractiveTerminal] Clipboard image error:", errorMessage);
  }, []);

  useClipboardImagePaste({
    containerId: containerId ?? null,
    worktreePath,
    isActive,
    onImageSaved: handleImageSaved,
    onError: handleImageError,
  });

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: `"${terminalAppearance.fontFamily}", "Fira Code", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`,
      fontSize: terminalAppearance.fontSize,
      lineHeight: 1.2,
      scrollback:
        typeof terminalScrollback === "number" && terminalScrollback > 0
          ? terminalScrollback
          : DEFAULT_TERMINAL_SCROLLBACK,
      theme: {
        background: terminalBackgroundColor,
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        cursorAccent: terminalBackgroundColor,
        selectionBackground: "#4b4b4b",
        black: "#1e1e1e",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#71717a",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f4f4f5",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void resizeInteractiveTerminal(sessionId, terminal.cols, terminal.rows);
      }
    };

    requestAnimationFrame(fit);

    const dataDisposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      void writeInteractiveTerminal(sessionId, data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      const key = event.key.toLowerCase();
      const isPasteShortcut = (event.metaKey || event.ctrlKey) && key === "v";
      if (isPasteShortcut && !event.altKey) {
        event.preventDefault();
        void handlePasteRef.current();
        return false;
      }

      return true;
    });

    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(host);

    let cancelled = false;

    const connect = async () => {
      let createdSessionId: string | null = null;
      let activeUnlisten: UnlistenFn | null = null;

      const cleanupCreatedSession = () => {
        const unlisten = activeUnlisten;
        activeUnlisten = null;
        unlisten?.();
        if (unlistenRef.current === unlisten) {
          unlistenRef.current = null;
        }
        if (createdSessionId) {
          void detachInteractiveTerminal(createdSessionId);
        }
        if (sessionIdRef.current === createdSessionId) {
          sessionIdRef.current = null;
        }
      };

      try {
        if (!environmentId) {
          setError("No environment specified for interactive terminal");
          return;
        }
        const sessionId = await createInteractiveTerminal(
          tabId,
          terminal.cols || 120,
          terminal.rows || 30,
          environmentId,
        );
        createdSessionId = sessionId;
        if (cancelled) {
          void detachInteractiveTerminal(sessionId);
          return;
        }

        sessionIdRef.current = sessionId;
        activeUnlisten = await listen<number[]>(
          `terminal-output-${sessionId}`,
          (event) => {
            terminal.write(new Uint8Array(event.payload));
          },
        );
        if (cancelled) {
          cleanupCreatedSession();
          return;
        }
        unlistenRef.current = activeUnlisten;

        await startInteractiveTerminal(sessionId);
        if (cancelled) return;
        setConnected(true);
        setError(null);
        fit();
        terminal.focus();
      } catch (e) {
        cleanupCreatedSession();
        if (!cancelled) setError(String(e));
      }
    };

    void connect();

    return () => {
      cancelled = true;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      setConnected(false);
      dataDisposable.dispose();
      resizeObserver.disconnect();
      unlistenRef.current?.();
      unlistenRef.current = null;
      if (sessionId) {
        void detachInteractiveTerminal(sessionId);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    tabId,
    environmentId,
    terminalAppearance.fontFamily,
    terminalAppearance.fontSize,
    terminalBackgroundColor,
    terminalScrollback,
  ]);

  useEffect(() => {
    if (!isActive) return;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      terminal.focus();
    });
  }, [isActive]);

  return (
    <div
      className={cn("relative h-full min-h-0 bg-black", className)}
      style={{ backgroundColor: terminalBackgroundColor }}
    >
      <div ref={terminalHostRef} className="h-full w-full p-2" />
      {(!connected || error) && (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-border/70 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          {error ?? "Attaching tmux..."}
        </div>
      )}
    </div>
  );
}
