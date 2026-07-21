import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("iPhone source-install docs state the current Mac and distribution boundary", async () => {
  const [readme, install, release] = await Promise.all([
    text("README.md"), text("docs/IOS_INSTALL.md"), text("docs/RELEASE_0.7.0.md")
  ]);
  for (const document of [readme, install, release]) {
    const prose = document.replace(/^> ?/gm, "");
    assert.match(prose, /Mac(?: with)?[^.\n]*Xcode/i);
    assert.match(prose, /control only\s+(?:a\s+)?Windows/i);
    assert.match(prose, /App Store/);
  }
  assert.match(install, /git clone --branch v0\.7\.0\.1 --depth 1/);
});

test("release docs preserve inspiration credit and independent implementation wording", async () => {
  const [readme, release] = await Promise.all([
    text("README.md"), text("docs/RELEASE_0.7.0.md")
  ]);
  for (const document of [readme, release]) {
    assert.match(document, /Shikhar \(@xikhar\)/);
    assert.match(document, /https:\/\/x\.com\/xikhar/);
    assert.match(document, /independent implementation/i);
  }
});

test("local Wi-Fi guide proves Nearby works with Tailscale off and keeps CDP private", async () => {
  const guide = await text("docs/IOS_LOCAL_WIFI.md");
  assert.match(guide, /mobile-local-config/);
  assert.match(guide, /Configure-CodexDeckMobile\.ps1 -Local/);
  assert.match(guide, /turn Tailscale off/i);
  assert.match(guide, /Keep Wi-Fi enabled/i);
  assert.match(guide, /Chrome DevTools/);
  assert.doesNotMatch(guide, /0\.0\.0\.0/);
});
