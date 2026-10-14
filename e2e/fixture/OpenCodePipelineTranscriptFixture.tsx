import { useEffect, useState } from "react";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { toPipelineTranscript } from "../../apps/web/src/components/build-pipeline/pipeline-transcript";

/** Receives only display rows from the backend boundary exercised by the spec. */
export function OpenCodePipelineTranscriptFixture() {
  const [entries, setEntries] = useState<unknown[] | null>(null);
  const [error, setError] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let active = true;
    void fetch("/fixture-opencode-display-transcript")
      .then((response) => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json() as Promise<unknown[]>;
      })
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const rows = toPipelineTranscript(entries ?? [], "opencode", "2026-10-14T10:00:00.000Z");
  return (
    <main className="mx-auto max-w-3xl p-4">
      <button onClick={() => setVisible((value) => !value)}>Switch transcript</button>
      {error ? (
        <p role="alert">Transcript unavailable</p>
      ) : entries === null ? (
        <p>Loading transcript</p>
      ) : null}
      {visible ? (
        <section aria-label="Pipeline transcript">
          {rows.map((message, index) => (
            <NativeMessage
              key={message.id}
              message={message}
              previousMessage={rows[index - 1]}
              platform="opencode"
            />
          ))}
        </section>
      ) : (
        <p>Another tab</p>
      )}
    </main>
  );
}
