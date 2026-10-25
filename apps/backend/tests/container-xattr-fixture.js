// Linux-only fixture, run as root inside the qualification image. Read the raw
// xattrs so equality proves capabilities survived, rather than just tar flags.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { chownSync, mkdirSync, writeFileSync } from "node:fs";

const { symbols } = dlopen("libc.so.6", {
  setxattr: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32],
    returns: FFIType.i32,
  },
  getxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});
const root = process.argv[3];
const cstr = (value) => Buffer.from(`${value}\0`);
if (process.argv[2] === "seed") {
  mkdirSync(`${root}/directory`, { recursive: true });
  writeFileSync(`${root}/tool`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const file of ["tool", "directory"]) {
    // Workload files belong to node. Restoring that ownership can clear a
    // capability if the helper applies metadata in the wrong order.
    chownSync(`${root}/${file}`, 1000, 1000);
    const value = Buffer.from([0, 1, 2, 255]);
    if (
      symbols.setxattr(
        ptr(cstr(`${root}/${file}`)),
        ptr(cstr("user.orkestrator-test")),
        ptr(value),
        value.length,
        0,
      ) !== 0
    )
      throw new Error("could not seed user xattr");
  }
  const cap = Bun.spawnSync(["setcap", "cap_net_bind_service=ep", `${root}/tool`]);
  if (cap.exitCode !== 0) throw new Error("could not seed file capability");
}
const values = [];
for (const [file, name] of [
  ["tool", "user.orkestrator-test"],
  ["directory", "user.orkestrator-test"],
  ["tool", "security.capability"],
]) {
  const value = Buffer.alloc(1024);
  const size = Number(
    symbols.getxattr(ptr(cstr(`${root}/${file}`)), ptr(cstr(name)), ptr(value), value.length),
  );
  if (size <= 0) throw new Error(`missing fixture xattr: ${file} ${name}`);
  values.push(value.subarray(0, size).toString("hex"));
}
console.log(JSON.stringify(values));
