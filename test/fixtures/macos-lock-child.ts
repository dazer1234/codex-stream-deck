import { createInterface } from "node:readline";
import { acquirePidLock } from "../../launcher/macos/codex-deck-macos.js";

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
console.log("ready");
await lines.next();
const release = await acquirePidLock(process.argv[2]!);
console.log(release ? "acquired" : "busy");
await lines.next();
await release?.();
process.exit(0);
