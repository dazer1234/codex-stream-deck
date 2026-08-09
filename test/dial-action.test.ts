import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import type { DeckController } from "../src/controller.js";
import { CodexDialAction } from "../src/dial-action.js";

const execFileAsync = promisify(execFile);
const text = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

type ManifestAction = {
  UUID: string;
  Controllers?: string[];
  Encoder?: {
    Icon?: string;
    layout?: string;
    TriggerDescription?: Record<string, string>;
  };
  PropertyInspectorPath?: string;
};

type ControllerCall = { method: string; action: unknown; payload?: unknown };

function adapterHarness(): { adapter: CodexDialAction; calls: ControllerCall[] } {
  const calls: ControllerCall[] = [];
  const controller = {
    registerDial(action: unknown, settings: unknown) { calls.push({ method: "register", action, payload: settings }); },
    updateDialSettings(action: unknown, settings: unknown) { calls.push({ method: "settings", action, payload: settings }); },
    unregisterDial(action: unknown) { calls.push({ method: "unregister", action }); },
    rotateDial(action: unknown, ticks: number) { calls.push({ method: "rotate", action, payload: ticks }); },
    async beginDialPress(action: unknown) { calls.push({ method: "down", action }); },
    async finishDialPress(action: unknown) { calls.push({ method: "up", action }); },
    async touchDial(action: unknown) { calls.push({ method: "touch", action }); }
  };
  return {
    adapter: new CodexDialAction(controller as unknown as DeckController),
    calls
  };
}

test("manifest adds exactly one Encoder-only Codex Dial without changing keypad actions", async () => {
  const manifest = JSON.parse(await text("static/manifest.json")) as { Version: string; Actions: ManifestAction[] };
  const uuids = manifest.Actions.map(({ UUID }) => UUID);
  const dials = manifest.Actions.filter(({ UUID }) => UUID === "com.simeo.codex-deck.codex-dial");

  assert.equal(manifest.Version, "0.7.0.2");
  assert.equal(manifest.Actions.length, 54, "the existing 53 actions plus Codex Dial remain present");
  assert.equal(new Set(uuids).size, uuids.length, "every action UUID is unique");
  assert.equal(dials.length, 1);
  assert.deepEqual(dials[0]?.Controllers, ["Encoder"]);
  assert.equal(dials[0]?.Encoder?.Icon, "static/imgs/dial");
  assert.equal(dials[0]?.Encoder?.layout, "static/layouts/codex-dial.json");
  assert.equal(dials[0]?.PropertyInspectorPath, "static/property-inspector/codex-dial.html");
  assert.deepEqual(Object.keys(dials[0]?.Encoder?.TriggerDescription ?? {}).sort(), ["Push", "Rotate", "Touch"]);
  for (const action of manifest.Actions.filter(({ UUID }) => UUID !== "com.simeo.codex-deck.codex-dial")) {
    assert.deepEqual(action.Controllers, ["Keypad"], `${action.UUID} remains keypad-only`);
  }
});

test("Codex Dial adapter forwards all Encoder event families and ignores held touch", async () => {
  const { adapter, calls } = adapterHarness();
  const dial = { id: "dial-1", isDial: () => true };
  const settings = { version: 1, preset: "reasoning" };

  adapter.onWillAppear({ action: dial, payload: { settings } } as never);
  adapter.onDidReceiveSettings({ action: dial, payload: { settings } } as never);
  adapter.onDialRotate({ action: dial, payload: { ticks: -2 } } as never);
  await adapter.onDialDown({ action: dial } as never);
  await adapter.onDialUp({ action: dial } as never);
  await adapter.onTouchTap({ action: dial, payload: { hold: false } } as never);
  await adapter.onTouchTap({ action: dial, payload: { hold: true } } as never);
  adapter.onWillDisappear({ action: dial } as never);

  assert.equal(adapter.manifestId, "com.simeo.codex-deck.codex-dial");
  assert.deepEqual(calls.map(({ method }) => method), [
    "register", "settings", "rotate", "down", "up", "touch", "unregister"
  ]);
  assert.equal(calls[0]?.action, dial);
  assert.equal(calls[0]?.payload, settings);
  assert.equal(calls[2]?.payload, -2);
});

test("Codex Dial registration paths reject non-dial actions", () => {
  const { adapter, calls } = adapterHarness();
  const key = { id: "key-1", isDial: () => false };

  adapter.onWillAppear({ action: key, payload: { settings: {} } } as never);
  adapter.onDidReceiveSettings({ action: key, payload: { settings: {} } } as never);

  assert.deepEqual(calls, []);
  assert.equal("onKeyDown" in adapter, false);
  assert.equal("onKeyUp" in adapter, false);
});

test("plugin registers Codex Dial exactly once", async () => {
  const source = await text("src/plugin.ts");
  assert.equal(source.match(/new CodexDialAction\(controller\)/g)?.length, 1);
});

test("custom layout has five unique typed keys inside the 200 by 100 Encoder canvas", async () => {
  const layout = JSON.parse(await text("static/layouts/codex-dial.json")) as {
    id: string;
    items: Array<{ key: string; type: string; rect: number[] }>;
  };
  const expectedTypes = new Map([
    ["accent", "bar"], ["detail", "text"], ["indicator", "bar"], ["title", "text"], ["value", "text"]
  ]);
  const keys = layout.items.map(({ key }) => key);

  assert.equal(layout.id, "com.simeo.codex-deck.codex-dial.layout");
  assert.equal(layout.items.length, 5);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), [...expectedTypes.keys()].sort());
  for (const { key, type, rect } of layout.items) {
    assert.equal(type, expectedTypes.get(key));
    assert.equal(rect.length, 4);
    const [x, y, width, height] = rect;
    assert.ok(x !== undefined && y !== undefined && width !== undefined && height !== undefined);
    assert.ok(x >= 0 && y >= 0 && width >= 0 && height >= 0);
    assert.ok(x + width <= 200 && y + height <= 100, `${key} stays within the Encoder canvas`);
  }
});

test("dial artwork and the Task 5 inspector shell are self-contained", async () => {
  const [dial, dial2x, inspector] = await Promise.all([
    text("static/imgs/dial.svg"),
    text("static/imgs/dial@2x.svg"),
    text("static/property-inspector/codex-dial.html")
  ]);

  assert.match(dial, /width="72" height="72"/);
  assert.match(dial2x, /width="144" height="144"/);
  assert.doesNotMatch(`${dial}${dial2x}`, /<image|href=/i, "artwork does not embed third-party assets");
  assert.match(inspector, /connectElgatoStreamDeckSocket/);
  assert.match(inspector, /new WebSocket/);
  assert.doesNotMatch(inspector, /<input|<select|<button/i, "full configuration controls belong to Task 6");
});

test("build emits every Encoder asset at its manifest path", async () => {
  await execFileAsync(process.execPath, ["scripts/build.mjs"], { cwd: new URL("..", import.meta.url) });
  for (const path of [
    "dist/com.simeo.codex-deck.sdPlugin/static/imgs/dial.svg",
    "dist/com.simeo.codex-deck.sdPlugin/static/imgs/dial@2x.svg",
    "dist/com.simeo.codex-deck.sdPlugin/static/layouts/codex-dial.json",
    "dist/com.simeo.codex-deck.sdPlugin/static/property-inspector/codex-dial.html"
  ]) await access(new URL(`../${path}`, import.meta.url));
});
