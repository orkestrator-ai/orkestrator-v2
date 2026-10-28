import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { Worker } from "node:worker_threads";
import { installSocketTypeOfServiceGuard } from "../../electron/socket-tos-guard";

type TosSocket = net.Socket & { setTypeOfService(tos: number): net.Socket };
const prototype = net.Socket.prototype as TosSocket;
const nativeSetter = prototype.setTypeOfService;
assert.equal(typeof nativeSetter, "function", "Electron must expose the native TOS setter");
const unused = new net.Socket() as TosSocket;
assert.equal(nativeSetter.call(unused, 0), unused);
assert.throws(() => nativeSetter.call(unused, 999), { code: "ERR_OUT_OF_RANGE" });

// Keep the peer in another thread: the client must receive the kernel RST
// while its JS connect callback is still running, before Node closes its handle.
// This reproduces the undici race without fabricating a setter error or errno.
const reset = new Int32Array(new SharedArrayBuffer(4));
const peer = new Worker(
  `
    const { parentPort, workerData } = require("node:worker_threads");
    const net = require("node:net");
    let socket;
    let requested = false;
    function resetPeer() {
      if (!socket || !requested) return;
      socket.resetAndDestroy();
      Atomics.store(workerData, 0, 1);
      Atomics.notify(workerData, 0);
    }
    const server = net.createServer((accepted) => {
      socket = accepted;
      socket.on("error", () => {});
      resetPeer();
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    parentPort.on("message", () => { requested = true; resetPeer(); });
  `,
  { eval: true, execArgv: [], workerData: reset },
);

let setterCalls = 0;
let nativeFailures = 0;
try {
  const [port] = await once(peer, "message");
  // Observe the real setter and synchronize the peer reset at undici's call.
  // The exception below is created by Electron's Node, including its syscall.
  prototype.setTypeOfService = function (tos: number) {
    setterCalls++;
    peer.postMessage("reset");
    assert.notEqual(Atomics.wait(reset, 0, 0, 5_000), "timed-out", "peer did not reset");
    try {
      return nativeSetter.call(this, tos);
    } catch (error) {
      nativeFailures++;
      assert.equal((error as NodeJS.ErrnoException).code, "EINVAL");
      assert.equal((error as NodeJS.ErrnoException).syscall, "setTypeOfService");
      throw error;
    }
  };
  if (process.argv[2] === "guarded") {
    const observedSetter = prototype.setTypeOfService;
    installSocketTypeOfServiceGuard();
    assert.notEqual(prototype.setTypeOfService, observedSetter);
    const guardedSetter = prototype.setTypeOfService;
    installSocketTypeOfServiceGuard();
    assert.equal(prototype.setTypeOfService, guardedSetter);
    // Do not intercept uncaughtException: an escaped socket-event error must
    // terminate this child and fail the parent test, just as in the app.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/reset`), TypeError);
    assert.equal(setterCalls, 1);
    assert.equal(nativeFailures, 1);
    process.stdout.write("guarded reset fetch rejected normally\n");
  } else {
    await fetch(`http://127.0.0.1:${port}/reset`);
    assert.fail("unguarded reset fetch must raise an uncaught socket-event exception");
  }
} finally {
  prototype.setTypeOfService = nativeSetter;
  unused.destroy();
  await peer.terminate();
}
