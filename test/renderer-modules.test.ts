import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { discoverRendererModules, rendererModulesExpression } from "../src/renderer-modules.js";
import { buildRuntimeOverrideExpression, buildRuntimeVerificationExpression } from "../launcher/runtime-override.js";

async function discover(resources: string[], modules: Record<string, unknown>) {
  const loaded: string[] = [];
  const context = vm.createContext({
    document: { querySelectorAll: () => resources.map(src => ({ src })) },
    performance: { getEntriesByType: () => [] },
    load: async (url: string) => { loaded.push(url); return modules[url]; }
  });
  const result = await new vm.Script(`(${discoverRendererModules.toString()})(load)`).runInContext(context);
  return { ...result, loaded };
}

test("discovers legacy ESM slot exports and ignores unrelated resources", async () => {
  const slots = { resolver: {} };
  const result = await discover(["app://-/assets/codex-micro-slot-signals-test.js", "https://example.com/x.png"], {
    "app://-/assets/codex-micro-slot-signals-test.js": slots
  });
  assert.equal(result.slotNamespaces[0], slots);
  assert.equal(result.namespaces[0], slots);
  assert.equal(result.loaded.length, 1);
});

test("reads initialized Rspack exports without executing unloaded or failed factories", async () => {
  let invoked = false;
  const runtime = Object.assign(() => { invoked = true; }, {
    c: {
      bus: { exports: { bus: { handlers: new Map() } } },
      slots: { exports: { slots: { resolve() {}, createSubscriberAtom() {} } } },
      failed: { error: new Error("failed"), exports: { unsafe: true } }
    },
    m: {
      slots: function () { return { inactivityTimeoutMs: 1, voiceState: null, slots: [] }; },
      unloaded: () => { invoked = true; }
    }
  });
  const result = await discover(["app://-/assets/123.hash.js", "app://-/assets/async/456.hash.js"], {
    "app://-/assets/123.hash.js": { __webpack_require__: runtime }
  });
  assert.equal(result.slotNamespaces.length, 1);
  assert.equal(typeof result.slotNamespaces[0].slots.resolve, "function");
  assert.equal(result.namespaces.some((ns: any) => ns.unsafe), false);
  assert.equal(invoked, false);
  assert.equal(result.loaded.length, 1);
});

test("skips inaccessible exports while retaining other exports from the same module", async () => {
  const exports = Object.defineProperty({ safe: 42 }, "throwing", {
    enumerable: true, get() { throw new Error("not accessible"); }
  });
  const window = new Proxy({}, { get() { throw new Error("cross origin"); } });
  const runtime = Object.assign(() => {}, { c: { a: { exports: {} as Record<string, unknown> } }, m: {} });
  // Preserve the getter instead of evaluating it while constructing the fixture.
  runtime.c.a.exports = Object.assign(Object.create(null), { window });
  Object.defineProperties(runtime.c.a.exports, Object.getOwnPropertyDescriptors(exports));
  const result = await discover(["app://-/assets/123.hash.js"], {
    "app://-/assets/123.hash.js": { __webpack_require__: runtime }
  });
  assert.equal(result.namespaces[1].safe, 42);
  assert.equal("throwing" in result.namespaces[1], false);
  assert.equal("window" in result.namespaces[1], false);
});

test("initialization and verification use the discovered bus to activate native input handlers", async () => {
  const handlers = new Map<string, Set<unknown>>([["codex-micro-device-state-changed", new Set([{}])]]);
  const events: unknown[] = [];
  const bus = {
    handlers,
    dispatchHostMessage(event: unknown) {
      events.push(event);
      handlers.set("codex-micro-hid-event", new Set([{}]));
      handlers.set("codex-micro-joystick-event", new Set([{}]));
    }
  };
  const context = vm.createContext({
    Map, setTimeout,
    __STATSIG__: { firstInstance: { checkGate: () => true } },
    document: { querySelectorAll: () => [], querySelector: () => null },
    performance: { getEntriesByType: () => [] },
    loadModules: async () => ({ namespaces: [{ bus }] })
  });
  const run = (expression: string) => new vm.Script(
    expression.replace(rendererModulesExpression(), "loadModules()")
  ).runInContext(context);
  const initialized = await run(buildRuntimeOverrideExpression());
  assert.equal(initialized.ready, true);
  assert.equal(initialized.deviceEventDispatched, true);
  assert.equal(events.length, 1);
  const verified = await run(buildRuntimeVerificationExpression());
  assert.equal(verified.ready, true);
  assert.equal(verified.hidHandlers, 1);
  assert.equal(verified.joystickHandlers, 1);
});
