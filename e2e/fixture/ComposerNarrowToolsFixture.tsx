import { NativeHeldSendFixture } from "./NativeHeldSendFixture";

/** Size the actual native agent tab without supplying its CSS container. */
export function ComposerNarrowToolsFixture() {
  const params = new URLSearchParams(window.location.search);
  const width = Number(params.get("width") ?? 900);
  return (
    <div data-testid="chat-column" className="h-screen" style={{ width }}>
      <NativeHeldSendFixture showHarness={false} designContext={params.has("design-context")} />
    </div>
  );
}
