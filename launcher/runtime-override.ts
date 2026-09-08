import WebSocket from "ws";
import { basename } from "node:path";

const MICRO_GATE = "3207467860";
const DETECTION_KEY = "codex-micro-has-ever-been-detected";
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function buildRuntimeOverrideExpression(gateName = MICRO_GATE): string {
  if (!/^\d+$/.test(gateName)) throw new Error("The feature gate must contain digits only.");

  return `(async () => {
    const gateName = ${JSON.stringify(gateName)};
    const statsig = globalThis.__STATSIG__;
    const clients = [...new Set([statsig?.firstInstance, ...Object.values(statsig?.instances ?? {})].filter(Boolean))];

    for (const client of clients) {
      if (client.overrideAdapter?.__codexDeckGate !== gateName) {
        const original = client.overrideAdapter ?? {};
        client.overrideAdapter = new Proxy(original, {
          get(target, property) {
            if (property === '__codexDeckGate') return gateName;
            if (property === 'getGateOverride') {
              return (gate, user, options) => {
                if (gate?.name === gateName) return { ...gate, value: true };
                const fallback = Reflect.get(target, property, target);
                return typeof fallback === 'function' ? fallback.call(target, gate, user, options) : gate;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      client._memoCache = {};
    }

    const urls = [
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ];
    const uniqueUrls = [...new Set(urls)].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const persistedUrl = uniqueUrls.find((url) => url.includes('/assets/persisted-signal-'));
    let detected = null;
    let detectionMethod = 'native-device-event';
    if (persistedUrl) {
      const persisted = await import(persistedUrl);
      if (typeof persisted.p !== 'function' || typeof persisted.b !== 'function') {
        return { ready: false, reason: 'persisted-signal-api-changed' };
      }
      persisted.b(${JSON.stringify(DETECTION_KEY)}, true);
      detected = Boolean(persisted.p(${JSON.stringify(DETECTION_KEY)}, false));
      detectionMethod = 'persisted-signal';
    }
    for (const client of clients) client.$emt?.({ name: 'values_updated' });

    // Newer Codex builds moved the persisted signal into a shared renderer
    // chunk. Announcing the native device through the already-loaded event bus
    // preserves the same Codex-owned detection path without naming that chunk.
    const likelyModules = uniqueUrls.filter((url) =>
      /(?:vscode-api|codex-micro|app-initial|artifact-tab-content)/.test(url)
    ).slice(0, 120);
    let nativeEventBus = false;
    let deviceHandlers = 0;
    let deviceEventDispatched = false;
    const eventDeadline = Date.now() + 5000;
    while (Date.now() < eventDeadline && !deviceEventDispatched) {
      for (const url of likelyModules) {
        try {
          const module = await import(url);
          const bus = Object.values(module).find((candidate) => candidate && typeof candidate === 'object' &&
            (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function'));
          if (!bus) continue;
          nativeEventBus = true;
          deviceHandlers = bus.handlers instanceof Map
            ? (bus.handlers.get('codex-micro-device-state-changed')?.size ?? 0)
            : 1;
          if (deviceHandlers === 0) continue;
          const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
          dispatch.call(bus, ${JSON.stringify({
            type: "codex-micro-device-state-changed",
            state: { status: "connected", error: null, battery: { percentage: 100, isCharging: true } }
          })});
          deviceEventDispatched = true;
          break;
        } catch { /* Ignore unrelated already-loaded renderer chunks. */ }
      }
      if (!deviceEventDispatched) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const enabled = clients.map((client) => Boolean(client.checkGate?.(gateName)));
    const gateReady = clients.length === 0 || enabled.every(Boolean);
    return {
      ready: gateReady && (detected === true || deviceEventDispatched),
      enabled,
      detected,
      detectionMethod,
      nativeEventBus,
      deviceHandlers,
      deviceEventDispatched,
      clients: clients.length
    };
  })()`;
}

export function buildRuntimeVerificationExpression(): string {
  return `(async () => {
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const likelyModules = urls.filter((url) =>
      /(?:vscode-api|codex-micro|app-initial|artifact-tab-content)/.test(url)
    ).slice(0, 120);
    let bus = null;
    for (const url of likelyModules) {
      try {
        const module = await import(url);
        bus = Object.values(module).find((candidate) => candidate && typeof candidate === 'object' &&
          (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function')) ?? null;
        if (bus?.handlers instanceof Map) break;
      } catch { /* Ignore unrelated already-loaded renderer chunks. */ }
    }
    const hidHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-hid-event')?.size ?? 0) : 0;
    const joystickHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-joystick-event')?.size ?? 0) : 0;
    const settingsLink = Boolean(document.querySelector('[href*="/settings/codex-micro"]'));
    const statsig = globalThis.__STATSIG__;
    const clients = [...new Set([statsig?.firstInstance, ...Object.values(statsig?.instances ?? {})].filter(Boolean))];
    const menuEnabled = settingsLink || (clients.length > 0 && clients.every((client) => Boolean(client.checkGate?.(${JSON.stringify(MICRO_GATE)}))));
    const handlersReady = Boolean(bus) && hidHandlers > 0 && joystickHandlers > 0;
    return {
      ready: handlersReady && (menuEnabled || clients.length === 0),
      menuEnabled,
      nativeEventBus: Boolean(bus),
      hidHandlers,
      joystickHandlers,
      modulesInspected: likelyModules.length
    };
  })()`;
}

type DebugTarget = { type?: string; url?: string; webSocketDebuggerUrl?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export function selectRuntimeTarget(targets: DebugTarget[]): DebugTarget | undefined {
  const pages = targets.filter((target) =>
    target.type === "page" && target.webSocketDebuggerUrl && target.url?.startsWith("app://")
  );
  const isIndexDocument = (target: DebugTarget): boolean => {
    try { return new URL(target.url!).pathname === "/index.html"; }
    catch { return false; }
  };
  const isAuxiliarySurface = (target: DebugTarget): boolean =>
    /avatar-overlay|composition-surface/i.test(target.url ?? "");

  return pages.find((target) => isIndexDocument(target) && !new URL(target.url!).search)
    ?? pages.find(isIndexDocument)
    ?? pages.find((target) => !isAuxiliarySurface(target) && !target.url?.includes("initialRoute="))
    ?? pages.find((target) => !isAuxiliarySurface(target));
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (raw) => this.handle(String(raw)));
  }

  evaluate(expression: string): Promise<unknown> {
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    return promise;
  }

  close(): void { this.socket.close(); }

  private handle(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; error?: { message?: string }; result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } };
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) return pending.reject(new Error(message.error.message ?? "CDP request failed."));
    if (message.result?.exceptionDetails) {
      return pending.reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text ?? "Codex runtime evaluation failed."));
    }
    pending.resolve(message.result?.result?.value);
  }
}

async function findTarget(port: number, timeout = 20_000): Promise<DebugTarget> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as DebugTarget[];
        const target = selectRuntimeTarget(targets);
        if (target) return target;
      }
    } catch { /* Codex is still starting. */ }
    await delay(250);
  }
  throw new Error("Timed out waiting for the Codex renderer.");
}

export async function applyRuntimeOverride(port: number, timeout = 20_000): Promise<unknown> {
  const target = await findTarget(port, timeout);
  const client = new CdpClient(target.webSocketDebuggerUrl!);
  await client.connect();
  try {
    const deadline = Date.now() + timeout;
    let result: unknown;
    while (Date.now() < deadline) {
      result = await client.evaluate(buildRuntimeOverrideExpression());
      if ((result as { ready?: boolean } | null)?.ready) return result;
      await delay(100);
    }
    throw new Error(`Timed out enabling the Codex Micro runtime: ${JSON.stringify(result)}`);
  } finally {
    client.close();
  }
}

export async function verifyMicroRuntime(port: number, timeout = 20_000): Promise<unknown> {
  const target = await findTarget(port, timeout);
  const client = new CdpClient(target.webSocketDebuggerUrl!);
  await client.connect();
  try {
    const deadline = Date.now() + timeout;
    let result: unknown;
    while (Date.now() < deadline) {
      result = await client.evaluate(buildRuntimeVerificationExpression());
      if ((result as { ready?: boolean } | null)?.ready) return result;
      await delay(250);
    }
    throw new Error(`Timed out verifying the Codex Micro runtime: ${JSON.stringify(result)}`);
  } finally {
    client.close();
  }
}

if (process.argv[1] && ["runtime-override.mjs", "runtime-override.ts"].includes(basename(process.argv[1]))) {
  const port = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Usage: node runtime-override.mjs <port>");
  const result = await applyRuntimeOverride(port);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
