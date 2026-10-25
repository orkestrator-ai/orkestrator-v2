import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";

export function KeyboardShortcutsFixture() {
  const host = useRef<HTMLDivElement>(null);
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
      <KeyboardShortcutsDialog platform="mac" />
    </main>
  );
}
