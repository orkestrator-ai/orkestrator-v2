import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { listen, type UnlistenFn } from "@/lib/native/events";
import { useClipboardImagePaste } from "@/hooks/useClipboardImagePaste";
import { decodeTerminalOutputPayload, type TerminalOutputPayload } from "@/hooks/useTerminal";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { openLinkExternally } from "@/lib/preview-link-external";
import { createTerminalLinkActivator } from "@/lib/terminal-links";
import { useNodeScope } from "@/lib/node-scope/providers";
import { backendForScope } from "@/lib/backend/scope-backend";
import { escapePathForTerminalInput, handleTerminalPaste } from "@/lib/terminal-paste";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";
import { MobileTerminalKeyBar } from "@/components/terminal/MobileTerminalKeyBar";
import { publishTerminalGeometryIfOwned } from "@/lib/terminal-geometry-owner";
import { isKeyboardShortcutsShortcut } from "@/lib/keyboard-shortcuts";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useClaudeTmuxClient } from "@/lib/claude-tmux-scope";
import { CLAUDE_TMUX_INTERACTIVE_RENEW_MS } from "@orkestrator/protocol/contract/domains/claude-tmux";

const log = createLogger("web.claude-tmux");

const INTERACTIVE_RECOVERY_MAX_ATTEMPTS = 2;

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
  const nodeTmux = useClaudeTmuxClient();
  const isMobile = useMediaQuery("(max-width: 767px)");
  // The tab's node: its settings and files panel answer a link click.
  const linkScope = useNodeScope();
  // Mirrored into a ref so neither the session-creating effect (whose cleanup
  // disposes the terminal and detaches the tmux session) nor the activation
  // effect has to depend on isMobile. Crossing the breakpoint must not tear
  // down a live attachment or steal focus from an already-active terminal.
  const isMobileRef = useRef(isMobile);
  const isActiveRef = useRef(isActive);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  // Bumped when the backend reports that it dropped this terminal (its lease
  // lapsed while the page slept or was throttled), to attach a new one.
  const [attachGeneration, setAttachGeneration] = useState(0);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ??
    DEFAULT_TERMINAL_APPEARANCE;
  const terminalScrollback = useConfigStore((state) => state.config.global.terminalScrollback);
  const terminalBackgroundColor = resolveTerminalBackgroundColor(
    terminalAppearance.backgroundColor,
  );

  const writeToTerminal = useCallback(
    async (data: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      await nodeTmux.writeInteractiveTerminal(sessionId, data);
    },
    [nodeTmux],
  );

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const handlePaste = useCallback(async () => {
    await handleTerminalPaste({
      writer: backendForScope(linkScope),
      containerId,
      worktreePath,
      writeToTerminal,
      focusTerminal,
      componentName: "ClaudeTmuxInteractiveTerminal",
    });
  }, [containerId, worktreePath, writeToTerminal, focusTerminal, linkScope]);

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
    log.error("clipboard.image-failed", { error: formatLogError(errorMessage) });
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
      linkHandler: {
        activate: createTerminalLinkActivator({
          environmentId: environmentId ?? "",
          sourceTabId: tabId,
          scope: () => linkScope,
          openExternal: (url) =>
            openLinkExternally({
              environmentId: environmentId ?? "",
              sourceTabId: tabId,
              url,
              scope: linkScope,
            }),
        }),
      },
      cursorBlink: true,
      cursorStyle: "block",
      // Option+drag selects on macOS even when tmux has mouse reporting on.
      macOptionClickForcesSelection: true,
      // Forced Option selection is linear (including in shells), not rectangular.
      // Disable Alt-click movement so short selection gestures never send arrow keys.
      altClickMovesCursor: false,
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
        void publishTerminalGeometryIfOwned(
          isActiveRef.current,
          terminal.cols,
          terminal.rows,
          (cols, rows) => nodeTmux.resizeInteractiveTerminal(sessionId, cols, rows),
        ).catch((resizeError) => {
          log.error("terminal.resize-failed", { sessionId, error: formatLogError(resizeError) });
        });
      }
    };

    requestAnimationFrame(fit);

    const dataDisposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      void nodeTmux.writeInteractiveTerminal(sessionId, data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      const key = event.key.toLowerCase();
      if (key === "w" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        return false;
      }
      if (isKeyboardShortcutsShortcut(event)) return false;

      if (key === "enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        terminal.input("\n");
        return false;
      }

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
    window.addEventListener("focus", fit);

    let cancelled = false;
    let createdSessionId: string | null = null;
    let activeUnlisten: UnlistenFn | null = null;
    let detached = false;
    const listenAbortController = new AbortController();
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    let renewInFlight = false;

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void renewLease();
    };
    const stopRenewing = () => {
      if (renewTimer !== null) clearInterval(renewTimer);
      renewTimer = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // The backend stops capturing a terminal whose client stops renewing, so a
    // reload, a closed window or a cut link no longer leaves its capture loop
    // running for nobody (to-do 7745). Unmount still detaches at once.
    async function renewLease(): Promise<void> {
      const sessionId = createdSessionId;
      if (renewInFlight || cancelled || !sessionId || detached) return;
      renewInFlight = true;
      try {
        const renewal = await nodeTmux.renewInteractiveTerminal(sessionId);
        if (cancelled || sessionIdRef.current !== sessionId) return;
        if (renewal === "unsupported") {
          // An older backend never detaches on its own.
          stopRenewing();
        } else if (renewal === "lapsed") {
          stopRenewing();
          log.info("terminal.lease-lapsed", { sessionId });
          setAttachGeneration((generation) => generation + 1);
        }
      } catch (renewError) {
        // Transient (a reconnecting link): the next renewal retries well
        // inside the lease.
        log.warn("terminal.renew-failed", { sessionId, error: formatLogError(renewError) });
      } finally {
        renewInFlight = false;
      }
    }
    const startRenewing = () => {
      if (renewTimer !== null) return;
      renewTimer = setInterval(() => void renewLease(), CLAUDE_TMUX_INTERACTIVE_RENEW_MS);
      document.addEventListener("visibilitychange", onVisibilityChange);
    };

    const cleanupCreatedSession = () => {
      stopRenewing();
      listenAbortController.abort();
      const unlisten = activeUnlisten;
      activeUnlisten = null;
      unlisten?.();
      if (unlistenRef.current === unlisten) {
        unlistenRef.current = null;
      }
      if (createdSessionId && !detached) {
        detached = true;
        void nodeTmux.detachInteractiveTerminal(createdSessionId);
      }
      if (sessionIdRef.current === createdSessionId) {
        sessionIdRef.current = null;
      }
    };

    const connect = async () => {
      try {
        if (!environmentId) {
          setError("No environment specified for interactive terminal");
          return;
        }
        const sessionId = await nodeTmux.createInteractiveTerminal(
          tabId,
          terminal.cols || 120,
          terminal.rows || 30,
          environmentId,
        );
        createdSessionId = sessionId;
        if (cancelled) {
          void nodeTmux.detachInteractiveTerminal(sessionId);
          return;
        }

        sessionIdRef.current = sessionId;
        startRenewing();
        let recoveryInFlight: Promise<void> | null = null;
        const recoverFromDesync = () => {
          if (recoveryInFlight) return;
          recoveryInFlight = (async () => {
            let recoveryError: unknown;
            for (let attempt = 0; attempt < INTERACTIVE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
              try {
                await nodeTmux.startInteractiveTerminal(sessionId);
                if (!cancelled && sessionIdRef.current === sessionId) {
                  setError(null);
                }
                return;
              } catch (error) {
                recoveryError = error;
                if (cancelled || sessionIdRef.current !== sessionId) return;
              }
            }
            log.error("terminal.recover-failed", {
              sessionId,
              error: formatLogError(recoveryError),
            });
            if (!cancelled && sessionIdRef.current === sessionId) {
              setError(`Terminal recovery failed: ${String(recoveryError)}`);
            }
          })().finally(() => {
            recoveryInFlight = null;
          });
        };
        activeUnlisten = await listen<TerminalOutputPayload>(
          `terminal-output-${sessionId}`,
          (event) => {
            const bytes = decodeTerminalOutputPayload(event.payload);
            if (bytes === null) {
              recoverFromDesync();
              return;
            }
            if (bytes?.length) terminal.write(bytes);
          },
          { signal: listenAbortController.signal },
        );
        if (cancelled) {
          cleanupCreatedSession();
          return;
        }
        unlistenRef.current = activeUnlisten;

        await nodeTmux.startInteractiveTerminal(sessionId);
        if (cancelled) return;
        setConnected(true);
        setError(null);
        fit();
        if (!isMobileRef.current) {
          terminal.focus();
        }
      } catch (e) {
        cleanupCreatedSession();
        if (!cancelled) setError(String(e));
      }
    };

    void connect();

    return () => {
      cancelled = true;
      cleanupCreatedSession();
      setConnected(false);
      dataDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("focus", fit);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    linkScope,
    tabId,
    environmentId,
    terminalAppearance.fontFamily,
    terminalAppearance.fontSize,
    terminalBackgroundColor,
    terminalScrollback,
    nodeTmux,
    attachGeneration,
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
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void publishTerminalGeometryIfOwned(true, terminal.cols, terminal.rows, (cols, rows) =>
          nodeTmux.resizeInteractiveTerminal(sessionId, cols, rows),
        ).catch((resizeError) => {
          log.error("terminal.resize-failed", { sessionId, error: formatLogError(resizeError) });
        });
      }
      if (!isMobileRef.current) {
        terminal.focus();
      }
    });
  }, [isActive, nodeTmux]);

  return (
    <div
      className={cn("relative h-full min-h-0 bg-black", isMobile && "flex flex-col", className)}
      style={{ backgroundColor: terminalBackgroundColor }}
    >
      <div
        ref={terminalHostRef}
        className={cn("w-full p-2", isMobile ? "min-h-0 flex-1" : "h-full")}
      />
      {isMobile && isActive && (
        <MobileTerminalKeyBar
          contained
          onInput={(data) => {
            // This path is interpreted by the backend and forwarded with
            // `tmux send-keys`, rather than written to a raw PTY. Keep the
            // canonical CSI form so the backend can map arrows to named tmux
            // keys and let tmux encode them for the pane's current mode.
            void writeToTerminal(data);
          }}
          disabled={!connected}
        />
      )}
      {(!connected || error) && (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-border/70 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          {error ?? "Attaching tmux..."}
        </div>
      )}
    </div>
  );
}
