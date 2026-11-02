import { useState } from "react";
import { EnvironmentStatusMarker } from "../../apps/web/src/components/environments/EnvironmentStatusMarker";

/** Isolates real tooltip hit testing and CSS from the row's own hover card. */
export function EnvironmentStatusMarkerFixture() {
  const [second, setSecond] = useState(false);
  const [waiting, setWaiting] = useState(false);
  return (
    <main className="flex flex-col gap-8 p-12">
      {[true, false].map((local) => (
        <div key={String(local)} className="flex flex-wrap gap-8">
          {[true, false].map((withMachine) =>
            (["inactive", "idle", "working", "waiting"] as const).map((state) => (
              <div
                key={`${withMachine}-${state}`}
                data-testid={`${local ? "circle" : "square"}-${withMachine ? "" : "neutral-"}${state}`}
              >
                <EnvironmentStatusMarker
                  local={local}
                  state={state}
                  machine={
                    withMachine
                      ? { name: "Build machine", colorToken: "teal", status: "Connected" }
                      : null
                  }
                />
              </div>
            )),
          )}
        </div>
      ))}
      <button onClick={() => setSecond(true)}>Mount second rings</button>
      <button onClick={() => setWaiting(true)}>Wait for input</button>
      {[true, false].map((local) => (
        <div key={String(local)} className="flex gap-8">
          {[false, ...(second ? [true] : [])].map((late) => (
            <div
              key={String(late)}
              data-testid={`sync-${local ? "circle" : "square"}-${late ? "late" : "early"}`}
            >
              <EnvironmentStatusMarker
                local={local}
                state={waiting ? "waiting" : "working"}
                machine={null}
              />
            </div>
          ))}
        </div>
      ))}
    </main>
  );
}
