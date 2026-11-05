import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readActiveThreadKey } from "../src/active-thread.js";

function element(key: string, visible = true, hidden = false) {
  return { getAttribute: () => key, getClientRects: () => visible ? [{}] : [], closest: () => hidden ? {} : null };
}

function read(sidebar: unknown, composers: unknown[]) {
  return new vm.Script(`(${readActiveThreadKey.toString()})()`).runInNewContext({
    document: { querySelector: () => sidebar, querySelectorAll: () => composers }
  });
}

test("active sidebar identity takes precedence over mounted background composers", () => {
  assert.equal(read(element("local:current"), [element("old"), element("current")]), "local:current");
});

test("without a sidebar only a visible, accessible composer supplies the active identity", () => {
  assert.equal(read(null, [element("offscreen", false), element("hidden", true, true), element("current")]), "current");
  assert.equal(read(null, [element("offscreen", false)]), null);
});
