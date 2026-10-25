type InteractionEnvelope = {
  ok: boolean;
  receipt?: { execution?: { interactions?: Array<{ id: string }> } };
};

export function pendingInteractionIds(envelope: InteractionEnvelope): string[] {
  return envelope.receipt?.execution?.interactions?.map((interaction) => interaction.id) ?? [];
}

/** Retry the renderer's asynchronous submission only while answered cards remain pending. */
export async function waitPastResolved<T extends { code: number; envelope: InteractionEnvelope }>(
  wait: () => T,
  answered: ReadonlySet<string>,
  clock = {
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
): Promise<T> {
  const deadline = clock.now() + 60_000;
  for (;;) {
    const result = wait();
    const pending = pendingInteractionIds(result.envelope);
    const stillAnswered =
      result.code === 6 && pending.length > 0 && pending.every((id) => answered.has(id));
    if (!stillAnswered || clock.now() >= deadline) return result;
    await clock.sleep(1_000);
  }
}
