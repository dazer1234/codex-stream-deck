import { open } from "node:fs/promises";

/** Read only the bounded ASAR index; never extract the application bundle. */
export async function findMicroSlotAsset(archivePath: string): Promise<string | undefined> {
  const file = await open(archivePath, "r");
  try {
    const prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) return undefined;
    const length = prefix.readUInt32LE(12);
    if (length < 2 || length > 32 * 1024 * 1024 || length > prefix.readUInt32LE(4) - 8) return undefined;
    const header = Buffer.alloc(length);
    if ((await file.read(header, 0, length, 16)).bytesRead !== length) return undefined;
    const index = JSON.parse(header.toString("utf8"));
    const files = index?.files?.webview?.files?.assets?.files;
    if (!files || typeof files !== "object") return undefined;
    const matches = Object.keys(files).filter((name) => /^codex-micro-slot-signals-[A-Za-z0-9_-]+\.js$/.test(name));
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return undefined; }
  finally { await file.close(); }
}
