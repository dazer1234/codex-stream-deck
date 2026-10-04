import { IpcStatusJsonParser } from "./codex-ipc-status-parser.js";

/** Incremental framing: advertised payload length never determines an allocation. */
export class IpcStatusFrameReader {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private remaining = 0;
  private parser?: IpcStatusJsonParser;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private processing = false;

  constructor(private readonly onTimeout: () => void = () => {}, private readonly frameTimeoutMs = 30_000) {}

  async push(chunk: Buffer): Promise<unknown[]> {
    if (this.closed) throw new Error("Codex IPC reader is closed");
    if (this.processing) throw new Error("Concurrent Codex IPC reads are unsupported");
    this.processing = true;
    const messages: unknown[] = [];
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.closed) throw new Error("Codex IPC reader is closed");
        if (!this.parser) {
          if (!this.timer) {
            this.timer = setTimeout(() => { this.close(); this.onTimeout(); }, this.frameTimeoutMs);
            this.timer.unref();
          }
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count; offset += count;
          if (this.headerBytes < 4) break;
          this.remaining = this.header.readUInt32LE(0);
          this.headerBytes = 0;
          if (!this.remaining) throw new Error("Codex IPC frame is empty");
          this.parser = new IpcStatusJsonParser();
        }
        // Bound tokenizer work per write even if the caller hands us a huge chunk.
        const count = Math.min(this.remaining, chunk.length - offset, 64 * 1024);
        if (count) await this.parser.write(chunk.subarray(offset, offset + count));
        this.remaining -= count; offset += count;
        if (!this.remaining) {
          const message = await this.parser.finish();
          if (this.closed) throw new Error("Codex IPC reader is closed");
          messages.push(message);
          this.parser.close(); this.parser = undefined;
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
        }
      }
      return messages;
    } catch (error) {
      this.close();
      throw error;
    } finally { this.processing = false; }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.parser?.close(); this.parser = undefined;
  }
}
