import { EnvironmentStatusMarker } from "../../apps/web/src/components/environments/EnvironmentStatusMarker";

/** Isolates real tooltip hit testing and CSS from the row's own hover card. */
export function EnvironmentStatusMarkerFixture() {
  return (
    <main className="flex flex-col gap-8 p-12">
      {[true, false].map((local) => (
        <div key={String(local)} className="flex gap-8">
          {(["inactive", "idle", "working", "waiting"] as const).map((state) => (
            <div key={state} data-testid={`${local ? "circle" : "square"}-${state}`}>
              <EnvironmentStatusMarker
                local={local}
                state={state}
                machine={{ name: "Build machine", colorToken: "teal", status: "Connected" }}
              />
            </div>
          ))}
          <div data-testid={`${local ? "circle" : "square"}-neutral`}>
            <EnvironmentStatusMarker local={local} state="inactive" machine={null} />
          </div>
        </div>
      ))}
    </main>
  );
}
