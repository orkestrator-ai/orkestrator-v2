/**
 * One bounded-wait helper, shared by every off-turn read this bridge makes.
 *
 * Catalogue reads, history reads and credential probes all talk to somebody
 * else's process or server, so each of them needs a ceiling. Keeping one
 * implementation means the timer is unref'd in exactly one place — a ref'd
 * timer here would hold the event loop open and stop the bridge exiting.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
