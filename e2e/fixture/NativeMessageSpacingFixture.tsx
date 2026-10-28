import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";

export function NativeMessageSpacingFixture() {
  return (
    <main className="mx-auto max-w-3xl p-4">
      {[
        { id: "two-paragraphs", content: "First paragraph.\n\nSecond paragraph." },
        { id: "single-paragraph", content: "Single paragraph." },
      ].map(({ id, content }) => (
        <section key={id} data-testid={id}>
          <NativeMessage
            message={{
              id,
              role: "user",
              content,
              createdAt: "2026-10-28T12:00:00Z",
              parts: [{ type: "text", content }],
            }}
          />
        </section>
      ))}
    </main>
  );
}
