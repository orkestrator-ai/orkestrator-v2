import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { DesignFrameBridge } from "@/components/design/frame-bridge";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";

export function KeyboardShortcutsFixture() {
  const host = useRef<HTMLDivElement>(null);
  const designBridge = useRef<DesignFrameBridge | null>(null);
  useEffect(() => () => designBridge.current?.close(), []);
  const [input, setInput] = useState("");
  useEffect(() => {
    const terminal = new Terminal({ cols: 40, rows: 4 });
    terminal.open(host.current!);
    const subscription = terminal.onData((data) => setInput((value) => value + data));
    return () => {
      subscription.dispose();
      terminal.dispose();
    };
  }, []);
  return (
    <main>
      <textarea aria-label="Composer" />
      <div ref={host} data-testid="terminal" />
      <output data-testid="terminal-input">{input}</output>
      <iframe
        title="Design preview"
        sandbox="allow-scripts"
        srcDoc={designBootstrap("keyboard-shortcuts-fixture-nonce")}
        onLoad={(event) => {
          designBridge.current?.close();
          const target = event.currentTarget.contentWindow!;
          designBridge.current = new DesignFrameBridge(target);
          void designBridge.current
            .ask({
              op: "render",
              html: '<input aria-label="Design input">',
            })
            .catch(() => undefined);
        }}
      />
      <iframe title="Service preview" sandbox="allow-scripts" />
      <KeyboardShortcutsDialog platform="mac" />
    </main>
  );
}
