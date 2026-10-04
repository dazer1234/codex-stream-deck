import Parser from "stream-json/Parser.js";

// Limits apply to retained status metadata, not the size of a conversation frame.
// Never enable packing: even a skipped JSON key/number/string may be enormous.
const MAX_DEPTH = 128;
const MAX_KEY = 128;
const MAX_SCALAR = 4096;
const MAX_METADATA = 256 * 1024;
const TOKENIZER_CHUNK = 16 * 1024;

type Role = "root" | "result" | "params" | "change" | "state" | "runtime" |
  "flags" | "requests" | "patches" | "patch" | "path" | "scalar" | "patchValue" | "skip";
type Value = Record<string, any> | any[];
type Frame = { role: Role; value?: Value; key?: string; array: boolean; patchValueKind?: "runtime" | "requests" };
type Token = { name: string; value?: string | number | boolean | null };
const fields: Partial<Record<Role, Record<string, Role>>> = {
  root: { type: "scalar", method: "scalar", version: "scalar", requestId: "scalar", sourceClientId: "scalar", resultType: "scalar", result: "result", params: "params" },
  result: { clientId: "scalar" },
  params: { hostId: "scalar", conversationId: "scalar", clientId: "scalar", status: "scalar", following: "scalar", change: "change" },
  change: { type: "scalar", revision: "scalar", baseRevision: "scalar", conversationState: "state", patches: "patches" },
  state: { title: "scalar", threadRuntimeStatus: "runtime", hasUnreadTurn: "scalar", requests: "requests" },
  runtime: { type: "scalar", activeFlags: "flags" },
  patch: { op: "scalar", path: "path", value: "patchValue" },
};

/** Streaming, content-free projection of one JSON IPC body.
 * A patch with __codexStatusValueOmitted=true MUST invalidate relevant live state;
 * its omitted value must never be interpreted as a remove, empty array, or idle.
 */
export class IpcStatusJsonParser {
  private readonly parser = new Parser({ packValues: false, streamValues: true });
  private readonly frames: Frame[] = [];
  private root?: Value;
  private rootStarted = false;
  private retained = 0;
  private scalar?: { key: boolean; role: Role; value: string; overflow: boolean; number: boolean };
  private failure?: Error;
  private closed = false;
  private finished = false;
  private busy = false;
  private rejectPending?: (error: Error) => void;

  constructor() {
    this.parser.on("data", (token: Token) => {
      if (this.failure || this.closed) return;
      try { this.token(token); } catch { this.fail(); }
    });
    // Dependency errors may contain input context: never expose them to callers.
    this.parser.on("error", () => this.fail());
  }

  async write(chunk: Buffer): Promise<void> {
    this.check();
    if (this.busy || this.finished) throw new Error("Invalid Codex IPC parser lifecycle");
    this.busy = true;
    try {
      for (let offset = 0; offset < chunk.length; offset += TOKENIZER_CHUNK) {
        await new Promise<void>((resolve, reject) => {
          this.rejectPending = reject;
          this.parser.write(chunk.subarray(offset, offset + TOKENIZER_CHUNK), error => {
            this.rejectPending = undefined;
            if (error || this.failure) reject(this.failure ?? this.fail());
            else resolve();
          });
        });
        this.check();
      }
    } finally { this.busy = false; }
  }

  async finish(): Promise<unknown> {
    this.check();
    if (this.busy || this.finished) throw new Error("Invalid Codex IPC parser lifecycle");
    this.finished = true;
    await new Promise<void>((resolve, reject) => {
      this.rejectPending = reject;
      this.parser.end(() => {
        this.rejectPending = undefined;
        if (this.failure) reject(this.failure); else resolve();
      });
    });
    this.check();
    if (!this.root || this.frames.length || this.scalar) throw this.fail();
    return this.root;
  }

  close(): void {
    this.closed = true;
    this.frames.length = 0;
    this.root = undefined;
    this.scalar = undefined;
    this.rejectPending?.(new Error("Codex IPC parser closed"));
    this.rejectPending = undefined;
    this.parser.destroy();
  }

  private fail(): Error {
    this.failure ??= new Error("Invalid or excessive Codex IPC status metadata");
    this.rejectPending?.(this.failure);
    this.rejectPending = undefined;
    this.parser.destroy();
    return this.failure;
  }

  private check(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Codex IPC parser closed");
  }

  private reserve(bytes: number): void {
    this.retained += bytes;
    if (this.retained > MAX_METADATA) throw this.fail();
  }

  private target(): Role {
    const parent = this.frames.at(-1);
    if (!parent) {
      if (this.rootStarted) throw this.fail();
      this.rootStarted = true;
      return "root";
    }
    if (parent.role === "requests") {
      const value = parent.value as any[];
      if (!value.length) { this.reserve(16); value.push(true); }
      return "skip";
    }
    if (parent.role === "patches") return "patch";
    if (parent.role === "path" || parent.role === "flags") return "scalar";
    const shape = fields[parent.role];
    return parent.key !== undefined && shape && Object.hasOwn(shape, parent.key) ? shape[parent.key]! : "skip";
  }

  private attach(value: unknown): void {
    this.reserve(64 + (typeof value === "string" ? value.length * 2 : 0));
    const parent = this.frames.at(-1);
    if (!parent) { this.root = value as Value; return; }
    if (parent.array) (parent.value as any[]).push(value);
    else (parent.value as Record<string, unknown>)[parent.key!] = value;
  }

  private omitPatchValue(): void {
    const parent = this.frames.at(-1)!;
    this.reserve(64);
    (parent.value as Record<string, unknown>).__codexStatusValueOmitted = true;
    delete (parent.value as Record<string, unknown>).value;
  }

  private token(token: Token): void {
    switch (token.name) {
      case "startKey":
        this.scalar = { key: true, role: "skip", value: "", overflow: false, number: false };
        return;
      case "endKey": {
        const key = this.scalar!;
        this.frames.at(-1)!.key = key.overflow ? undefined : key.value;
        this.scalar = undefined;
        return;
      }
      case "startString": case "startNumber":
        this.scalar = { key: false, role: this.target(), value: "", overflow: false, number: token.name === "startNumber" };
        return;
      case "stringChunk": case "numberChunk": {
        const scalar = this.scalar!;
        if (scalar.overflow || (!scalar.key && scalar.role === "skip")) return;
        const chunk = String(token.value);
        if (scalar.value.length + chunk.length > (scalar.key ? MAX_KEY : MAX_SCALAR)) {
          scalar.overflow = true;
          scalar.value = "";
          if (!scalar.key && scalar.role !== "patchValue") throw this.fail();
        } else scalar.value += chunk;
        return;
      }
      case "endString": case "endNumber": {
        const scalar = this.scalar!;
        this.scalar = undefined;
        if (scalar.overflow) this.omitPatchValue();
        else this.primitive(scalar.role, scalar.number ? Number(scalar.value) : scalar.value);
        return;
      }
      case "trueValue": case "falseValue": case "nullValue":
        this.primitive(this.target(), token.value);
        return;
      case "startObject": case "startArray": {
        let role = this.target();
        const array = token.name === "startArray";
        if (role === "patchValue") {
          // The path can follow the value in JSON. Retain only two useful tiny
          // shapes, then validate their meaning when the whole patch is known.
          role = array ? "requests" : "runtime";
          this.frames.at(-1)!.patchValueKind = role;
        }
        const expectedArray = ["flags", "requests", "patches", "path"].includes(role);
        if (role !== "skip" && (role === "scalar" || array !== expectedArray)) throw this.fail();
        if (this.frames.length >= MAX_DEPTH) throw this.fail();
        const value = role === "skip" ? undefined : array ? [] : Object.create(null);
        if (value) this.attach(value);
        this.frames.push({ role, value, array });
        return;
      }
      case "endObject": case "endArray": {
        const frame = this.frames.at(-1)!;
        if (frame.role === "patch") {
          const patch = frame.value as Record<string, any>;
          const field = Array.isArray(patch.path) && patch.path.length === 1 ? patch.path[0] : undefined;
          const relevant = ["title", "hasUnreadTurn", "threadRuntimeStatus", "requests"].includes(field);
          const supportedContainer = frame.patchValueKind === "runtime" ? field === "threadRuntimeStatus" : field === "requests";
          if (Object.hasOwn(patch, "value") && (!relevant || (frame.patchValueKind && !supportedContainer))) {
            this.omitPatchValue();
          }
        }
        this.frames.pop();
        return;
      }
    }
  }

  private primitive(role: Role, value: unknown): void {
    if (role === "skip") return;
    if (role !== "scalar" && role !== "patchValue") throw this.fail();
    if (typeof value === "number" && !Number.isFinite(value)) throw this.fail();
    this.attach(value);
  }
}
