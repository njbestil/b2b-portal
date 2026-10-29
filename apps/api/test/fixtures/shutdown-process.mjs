// Cross-platform test harness: exercise real entry-point signal handlers without
// relying on Windows child.kill(), which terminates rather than delivering POSIX signals.
process.once("message", (signal) => {
  if (signal !== "SIGTERM" && signal !== "SIGINT")
    throw new Error("Invalid test signal");
  process.emit(signal);
  process.disconnect();
});
await import("../../dist/index.js");
