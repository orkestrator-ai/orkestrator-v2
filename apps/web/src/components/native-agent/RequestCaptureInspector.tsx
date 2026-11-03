import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { machineInvoke } from "@/lib/backend/agent-accounts";

type Snapshot = {
  index?: Record<
    string,
    { requestId?: string; messageId?: string; sessionId?: string; pairedFile?: string }
  >;
  enabled: boolean;
  files: { name: string; bytes: number; timestamp: string }[];
};

/** Content is fetched only when explicitly opening the inspector. Never logged. */
export function RequestCaptureInspector({ environmentId }: { environmentId: string }) {
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async (args: Record<string, unknown> = {}) => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await machineInvoke<Snapshot | { body: unknown }>(
        undefined,
        "claude_request_capture",
        { environmentId, ...args },
      );
      if (generation.current !== current) return;
      if ("body" in result) {
        setSelected(String(args.name));
        setBody(JSON.stringify(result.body, null, 2));
      } else {
        setSnapshot(result);
      }
    } catch (e) {
      if (generation.current !== current) return;
      setError(e instanceof Error ? e.message : "Could not read captures");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) void load();
        else {
          generation.current++;
          setSnapshot(null);
          setBusy(false);
          setBody("");
          setSelected("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          API request inspector
        </Button>
      </DialogTrigger>
      <DialogContent size="6xl" className="max-h-[95dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Claude API request inspector</DialogTitle>
          <DialogDescription>
            Inspect the system prompt, messages and tool definitions in captured API bodies. Capture
            starts with new Claude processes; restart the environment after changing this setting.
            Earlier requests cannot be reconstructed.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          These private files can contain source code, prompts and attachments. Claude redacts
          extended thinking. Requests without a response are retained too. Provider redactions or
          withheld content remain marked in the JSON. Retention sweeps keep up to 200 files / 128
          MiB, removing files over 16 MiB.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !snapshot}
            onClick={() => void load({ enabled: !snapshot?.enabled })}
          >
            {snapshot?.enabled
              ? "Disable capture for new processes"
              : "Enable capture for new processes"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            Refresh history
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {busy && <p role="status">Loading…</p>}
        {snapshot?.index?.[selected]?.pairedFile && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void load({ name: snapshot.index?.[selected]?.pairedFile })}
          >
            View paired request / response
          </Button>
        )}
        <Input
          aria-label="Find captured request"
          placeholder="Find by request, message or session ID…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="grid gap-3 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="max-h-96 overflow-auto space-y-1" aria-label="Captured API bodies">
            {snapshot?.files.length === 0 && (
              <p className="text-sm text-muted-foreground">No captured API bodies yet.</p>
            )}
            {snapshot?.files
              .filter((file) =>
                `${file.name} ${JSON.stringify(snapshot.index?.[file.name] ?? {})}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((file) => (
                <button
                  key={file.name}
                  disabled={busy}
                  aria-pressed={selected === file.name}
                  className="block w-full rounded border p-2 text-left text-xs hover:bg-muted"
                  onClick={() => void load({ name: file.name })}
                >
                  <span className="block">
                    {file.name.endsWith(".request.json") ? "Request" : "Response"} ·{" "}
                    {new Date(file.timestamp).toLocaleString()}
                  </span>
                  <span className="block break-all text-muted-foreground">
                    {file.name} · {Math.ceil(file.bytes / 1024)} KiB
                    {snapshot.index?.[file.name]?.requestId && (
                      <span className="block">{snapshot.index?.[file.name]?.requestId}</span>
                    )}
                  </span>
                </button>
              ))}
          </div>
          <pre
            aria-label="Captured body"
            className="h-96 min-w-0 overflow-auto rounded border bg-muted/30 p-3 text-xs"
          >
            {body || "Select a request or response to inspect its JSON."}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}
