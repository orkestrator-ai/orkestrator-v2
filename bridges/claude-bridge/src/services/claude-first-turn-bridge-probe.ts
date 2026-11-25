interface BridgeAttempt {
  port: number;
  token: string;
  exited(): boolean;
  stderr(): string;
  stop(): Promise<void>;
}

type BridgeCall = (path: string, init: RequestInit) => Promise<Response>;

class PortTakenError extends Error {}

async function startBridgeOnce(attempt: BridgeAttempt, startupMs: number, signal: AbortSignal) {
  const call: BridgeCall = (path, init) =>
    Bun.fetch(`http://127.0.0.1:${attempt.port}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "X-Orkestrator-Claude-Token": attempt.token,
      },
    });

  try {
    while (!signal.aborted) {
      // A foreign server can answer open health, but cannot accept this bridge's token.
      const status = await call("/global/auth-check", { signal }).then(
        (response) => response.status,
        () => undefined,
      );
      if (signal.aborted) break;
      if (status === 401)
        throw new PortTakenError(`Port ${attempt.port} belongs to another server`);
      if (status === 200 && !attempt.exited()) return { call, stop: attempt.stop };
      if (attempt.exited()) {
        // Let stderr deliver the bind failure printed on the way out.
        await Bun.sleep(250);
        const stderr = attempt.stderr();
        const message = `The bridge exited before it answered: ${stderr}`;
        throw /Is port \d+ in use\?|EADDRINUSE/.test(stderr)
          ? new PortTakenError(message)
          : new Error(message);
      }
      await Bun.sleep(25);
    }
    throw new Error(`The bridge did not answer within ${startupMs} ms: ${attempt.stderr()}`);
  } catch (error) {
    await attempt.stop();
    throw error;
  }
}

async function startBridge(
  launch: () => BridgeAttempt,
  startupMs: number,
  signalAfter: (ms: number) => AbortSignal,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startBridgeOnce(launch(), startupMs, signalAfter(startupMs));
    } catch (error) {
      if (!(error instanceof PortTakenError) || attempt >= 5) throw error;
    }
  }
}

export async function runBridgeFirstTurn(
  launch: () => BridgeAttempt,
  untilModelCall: (start: () => Promise<unknown>) => Promise<number>,
  { startupMs, turnMs }: { startupMs: number; turnMs: number },
  signalAfter = (ms: number) => AbortSignal.timeout(ms),
) {
  const bridge = await startBridge(launch, startupMs, signalAfter);
  try {
    const created = (await (
      await bridge.call("/session/create", {
        method: "POST",
        body: "{}",
        signal: signalAfter(startupMs),
      })
    ).json()) as { sessionId: string };
    const sessionPath = `/session/${created.sessionId}`;
    const send = async (prompt: string) => {
      const answer = await bridge.call(`${sessionPath}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt, permissionMode: "acceptEdits", model: "haiku" }),
        signal: signalAfter(turnMs),
      });
      if (!answer.ok) throw new Error(`Prompt refused: ${answer.status} ${await answer.text()}`);
      return answer.status;
    };
    let answered!: Promise<number>;
    const firstMs = await untilModelCall(() => (answered = send("Say ok.")));
    const firstStatus = await answered;

    const signal = signalAfter(turnMs);
    let status: string | undefined;
    try {
      while (!signal.aborted) {
        const state = (await (await bridge.call(sessionPath, { signal })).json()) as {
          status?: string;
        };
        status = state.status;
        if (status === "idle") break;
        await Bun.sleep(25);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    if (signal.aborted) {
      throw new Error(
        `The bridge session did not settle within ${turnMs} ms (last status: ${status ?? "unavailable"})`,
      );
    }

    const followUpMs = await untilModelCall(() => (answered = send("Say ok again.")));
    const followUpStatus = await answered;
    return { firstMs, followUpMs, firstStatus, followUpStatus };
  } finally {
    await bridge.stop();
  }
}
