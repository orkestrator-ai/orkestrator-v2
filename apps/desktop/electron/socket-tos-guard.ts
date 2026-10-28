import net from "node:net";

const GUARDED = Symbol.for("orkestrator.socketTypeOfServiceGuard");

type TypeOfServiceSocket = net.Socket & {
  setTypeOfService?: (tos: number) => net.Socket;
};

type GuardedSetter = ((this: net.Socket, tos: number) => net.Socket) & {
  [GUARDED]?: true;
};

/**
 * Makes `net.Socket#setTypeOfService` best-effort in the main process.
 *
 * The undici bundled with Electron 45's Node (7.29.x) calls `setTypeOfService`
 * on every HTTP/1.1 request without a try/catch. On macOS `setsockopt` returns
 * EINVAL once the peer has reset the connection, so a `fetch` racing a dropped
 * connection throws synchronously from a socket event handler and Electron
 * reports it as an uncaught main-process exception. Undici 8 already treats the
 * call as best-effort; this mirrors that. The request itself still fails through
 * the socket's normal ECONNRESET error path, which `fetch` callers handle.
 */
export function installSocketTypeOfServiceGuard(
  socketPrototype: TypeOfServiceSocket = net.Socket.prototype as TypeOfServiceSocket,
): void {
  const original = socketPrototype.setTypeOfService as GuardedSetter | undefined;
  if (typeof original !== "function" || original[GUARDED]) return;

  const guarded: GuardedSetter = function setTypeOfService(this: net.Socket, tos: number) {
    try {
      return original.call(this, tos);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.syscall === "setTypeOfService") return this;
      throw error;
    }
  };
  guarded[GUARDED] = true;
  socketPrototype.setTypeOfService = guarded;
}
