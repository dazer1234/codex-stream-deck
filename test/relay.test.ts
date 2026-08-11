import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { generate } from "selfsigned";
import { CodexRelayClient, RELAY_SNAPSHOT_STALE_MS, resolveRelayHealth } from "../src/codex-relay-client.js";
import { isAllowedRelayHost, isPrivateLanHost, privateLanAddresses } from "../src/relay-network.js";
import {
  CodexRelayServer, readRelayServerConfig, relayDiscoveryTxt,
  relaySnapshotFailureShouldDegrade, validateRelayServerConfig
} from "../src/codex-relay-server.js";
import {
  HostActivityIndex, RELAY_PROTOCOL_VERSION, normalizeHostSnapshotAtReceipt,
  parseRelayCommand, parseRelayServerMessage, type HostSnapshot
} from "../src/relay-protocol.js";
import type { CodexHost, MicroSnapshot } from "../src/types.js";

const host: CodexHost = { hostId: "56fd97ad-7073-42cc-85ce-befa17546d7c", hostName: "Test Mac", platform: "darwin" };
const snapshot: MicroSnapshot = {
  slots: Array.from({ length: 6 }, (_, id) => ({
    id, threadKey: `00000000-0000-4000-8000-00000000000${id}`, title: `Task ${id + 1}`,
    status: id === 0 ? "working" : "idle", selected: id === 0, activityAt: 1_000 - id
  })),
  layout: {
    version: 1,
    slots: {
      ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" }, ACT08: { keycapId: "REJ" },
      ACT09: { keycapId: "SPLIT" }, ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
    },
    analogStick: { up: {}, right: {}, down: {}, left: {} }
  },
  agentSource: "recent",
  lightingAutoOff: "3-minutes",
  theme: "dark"
};

test("relay refuses wildcard exposure and short authentication tokens", () => {
  assert.throws(() => validateRelayServerConfig({ enabled: true, listenHost: "0.0.0.0", port: 47_651, token: "x".repeat(32) }), /loopback or a specific Tailscale address/);
  assert.throws(() => validateRelayServerConfig({ enabled: true, listenHost: "203.0.113.10", port: 47_651, token: "x".repeat(32) }), /loopback or a specific Tailscale/);
  assert.throws(() => validateRelayServerConfig({ enabled: true, listenHost: "127.0.0.1", port: 47_651, token: "short" }), /32 bytes/);
  assert.equal(isAllowedRelayHost("100.64.0.42"), true);
  assert.equal(isAllowedRelayHost("example.tailnet.ts.net"), true);
  assert.equal(isAllowedRelayHost("8.8.8.8"), false);
});

test("nearby relay accepts only pinned TLS on a private address and never advertises its token", async () => {
  const certificate = await generate([{ name: "commonName", value: "Codex Deck test" }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256"
  });
  const fingerprint = new X509Certificate(certificate.cert).fingerprint256
    .replaceAll(":", "").toLowerCase();
  const local = {
    enabled: true,
    listenHost: "auto",
    port: 47_653,
    token: "secret".repeat(8),
    transport: "local" as const,
    tls: {
      certificate: certificate.cert,
      privateKey: certificate.private,
      fingerprintSha256: fingerprint
    },
    discovery: { enabled: true }
  };
  validateRelayServerConfig(local);
  const txt = relayDiscoveryTxt(local, host, "192.168.1.25");
  assert.equal(txt.hostId, host.hostId);
  assert.equal(txt.address, "192.168.1.25");
  assert.equal(txt.fingerprint, fingerprint);
  assert.equal(JSON.stringify(txt).includes(local.token), false);
  assert.equal("token" in txt, false);
  assert.throws(
    () => validateRelayServerConfig({ ...local, tls: undefined }), /requires pinned TLS/);
  assert.throws(
    () => validateRelayServerConfig({ ...local, listenHost: "203.0.113.8" }), /secure auto local mode/);
  assert.equal(isPrivateLanHost("10.0.0.4"), true);
  assert.equal(isPrivateLanHost("172.31.9.2"), true);
  assert.equal(isPrivateLanHost("192.168.50.9"), true);
  assert.equal(isPrivateLanHost("100.100.100.100"), false);
  assert.equal(isPrivateLanHost("8.8.8.8"), false);
  assert.deepEqual(privateLanAddresses({
    en0: [
      { address: "192.168.1.25", netmask: "255.255.255.0", family: "IPv4", mac: "aa", internal: false, cidr: "192.168.1.25/24" },
      { address: "fe80::1", netmask: "ffff::", family: "IPv6", mac: "aa", internal: false, cidr: "fe80::1/64", scopeid: 1 }
    ],
    vpn: [{ address: "100.100.100.100", netmask: "255.192.0.0", family: "IPv4", mac: "bb", internal: false, cidr: "100.100.100.100/10" }]
  }), ["192.168.1.25"]);
});

test("optional mobile relay config is absent-safe and validates before startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-mobile-relay-"));
  try {
    const path = join(root, "mobile-relay-server.json");
    assert.equal(await readRelayServerConfig(path), null);
    await writeFile(path, JSON.stringify({ enabled: true, listenHost: "127.0.0.1", port: 47_652, token: "m".repeat(32) }));
    assert.deepEqual(await readRelayServerConfig(path), {
      enabled: true, listenHost: "127.0.0.1", port: 47_652, token: "m".repeat(32)
    });
    await writeFile(path, JSON.stringify({ enabled: true, listenHost: "0.0.0.0", port: 47_652, token: "m".repeat(32) }));
    await assert.rejects(readRelayServerConfig(path), /loopback or a specific Tailscale address/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relay command parser permits only the narrow native command surface", () => {
  const threadKey = "00000000-0000-4000-8000-000000000005";
  assert.deepEqual(parseRelayCommand({ kind: "agent", slot: 5, threadKey, act: 1 }), { kind: "agent", slot: 5, threadKey, act: 1 });
  assert.deepEqual(
    parseRelayCommand({ kind: "reasoning", direction: "increase", includeUltra: true }),
    { kind: "reasoning", direction: "increase", includeUltra: true }
  );
  assert.deepEqual(
    parseRelayCommand({ kind: "reasoning", direction: "decrease", includeUltra: false }),
    { kind: "reasoning", direction: "decrease", includeUltra: false }
  );
  assert.deepEqual(parseRelayCommand({ kind: "rate-limit-reset" }), { kind: "rate-limit-reset" });
  assert.equal(parseRelayCommand({ kind: "rate-limit-reset", force: true }), null);
  assert.deepEqual(parseRelayCommand({ kind: "usage-refresh" }), { kind: "usage-refresh" });
  assert.equal(parseRelayCommand({ kind: "usage-refresh", expression: "process.exit()" }), null);
  assert.equal(parseRelayCommand({ kind: "agent", slot: 6, threadKey, act: 1 }), null);
  assert.equal(parseRelayCommand({ kind: "evaluate", expression: "process.exit()" }), null);
  assert.equal(parseRelayCommand({ kind: "keycap", keycapId: "NOT_REAL" }), null);
  assert.notEqual(parseRelayCommand({ kind: "agent", slot: 1, threadKey: "local:019f6de7-44c2-7fe2-9d17-9322c952e626", act: 1 }), null);
  assert.notEqual(parseRelayCommand({ kind: "agent", slot: 0, threadKey: "client-new-thread:e3c18619-71ff-4a8d-8dd3-d475e9bcf162", act: 1 }), null);
  assert.notEqual(parseRelayCommand({ kind: "agent", slot: 0, threadKey: "local:client-new-thread:e3c18619-71ff-4a8d-8dd3-d475e9bcf162", act: 1 }), null);
  assert.equal(parseRelayCommand({ kind: "agent", slot: 1, threadKey: "local:../../secret", act: 1 }), null);
});

test("relay reasoning commands require an explicit literal Ultra policy and exact own keys", () => {
  const inherited = Object.create({ includeUltra: true }) as Record<string, unknown>;
  inherited.kind = "reasoning";
  inherited.direction = "increase";
  let coercedDirection = false;
  const executableDirection = {
    toString() {
      coercedDirection = true;
      return "increase";
    }
  };
  for (const invalid of [
    { kind: "reasoning", direction: "increase" },
    inherited,
    { kind: "reasoning", direction: "increase", includeUltra: null },
    { kind: "reasoning", direction: "increase", includeUltra: 1 },
    { kind: "reasoning", direction: "increase", includeUltra: "true" },
    { kind: "reasoning", direction: "increase", includeUltra: {} },
    { kind: "reasoning", direction: "sideways", includeUltra: true },
    { kind: "reasoning", direction: executableDirection, includeUltra: true },
    { kind: "reasoning", direction: "increase", includeUltra: true, expression: "process.exit()" }
  ]) {
    assert.equal(parseRelayCommand(invalid), null, JSON.stringify(invalid));
  }
  assert.equal(coercedDirection, false, "strict parsing must not execute direction coercion hooks");
});

test("relay reasoning command parsing accepts only exact own data properties without invoking getters", () => {
  let getterReads = 0;
  for (const [property, value] of [
    ["kind", "reasoning"],
    ["direction", "increase"],
    ["includeUltra", true]
  ] as const) {
    const command: Record<string, unknown> = {
      kind: "reasoning", direction: "increase", includeUltra: true
    };
    Object.defineProperty(command, property, {
      enumerable: true,
      get() {
        getterReads += 1;
        return value;
      }
    });
    assert.equal(parseRelayCommand(command), null, `${property} getter`);
  }
  const nonEnumerableExtra = { kind: "reasoning", direction: "increase", includeUltra: true };
  Object.defineProperty(nonEnumerableExtra, "expression", { value: "process.exit()" });
  assert.equal(parseRelayCommand(nonEnumerableExtra), null);
  const symbolExtra = {
    kind: "reasoning", direction: "increase", includeUltra: true,
    [Symbol("expression")]: "process.exit()"
  };
  assert.equal(parseRelayCommand(symbolExtra), null);
  const inheritedKind = Object.assign(Object.create({
    get kind() {
      getterReads += 1;
      return "reasoning";
    }
  }) as Record<string, unknown>, { direction: "increase", includeUltra: true });
  assert.equal(parseRelayCommand(inheritedKind), null);
  assert.equal(getterReads, 0);

  assert.deepEqual(
    parseRelayCommand(JSON.parse('{"kind":"reasoning","direction":"increase","includeUltra":false}')),
    { kind: "reasoning", direction: "increase", includeUltra: false }
  );
});

test("iOS unrestricted reasoning commands encode the explicit Ultra policy", async () => {
  const source = await readFile(join(
    process.cwd(), "ios", "CodexDeckMobile", "Models", "RelayModels.swift"
  ), "utf8");
  const reasoningCase = source.match(
    /case \.reasoning\(let direction\):([\s\S]*?)case \.rateLimitReset:/
  )?.[1] ?? "";
  assert.match(reasoningCase, /try values\.encode\(true, forKey: \.includeUltra\)/);
  assert.match(source, /case kind, slot, threadKey, act, direction, distance, includeUltra, keycapId/);
});

test("relay snapshots accept an optional bounded reasoning effort", async () => {
  const { parseRelayServerMessage } = await import("../src/relay-protocol.js");
  const message = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: structuredClone(snapshot) };
  assert.notEqual(parseRelayServerMessage(message), null, "older peers may omit the optional field");
  message.snapshot.reasoningEffort = "high";
  assert.notEqual(parseRelayServerMessage(message), null);
  message.snapshot.reasoningEffort = "";
  assert.equal(parseRelayServerMessage(message), null);
  message.snapshot.reasoningEffort = "   ";
  assert.equal(parseRelayServerMessage(message), null);
  message.snapshot.reasoningEffort = "x".repeat(65);
  assert.equal(parseRelayServerMessage(message), null);
});

test("relay snapshots accept only an optional boolean Fast mode state", async () => {
  const message = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: structuredClone(snapshot) };
  assert.notEqual(parseRelayServerMessage(message), null, "older peers may omit the optional field");
  for (const fastModeEnabled of [true, false]) {
    message.snapshot.fastModeEnabled = fastModeEnabled;
    assert.notEqual(parseRelayServerMessage(message), null, `boolean ${fastModeEnabled} is valid`);
  }
  for (const fastModeEnabled of [null, 0, 1, "true", [], {}]) {
    message.snapshot.fastModeEnabled = fastModeEnabled as never;
    assert.equal(parseRelayServerMessage(message), null, `${JSON.stringify(fastModeEnabled)} must be rejected`);
  }
});

test("relay snapshot parser bounds and validates host session catalogs", async () => {
  const valid = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: structuredClone(snapshot) };
  valid.snapshot.hostSessions = [{ threadId: "00000000-0000-4000-8000-000000000000", activityAt: 1, status: "working", completionRevision: 42 }];
  valid.snapshot.hostSessions[0]!.contextUsedPercent = 56;
  valid.snapshot.slots[0]!.contextUsedPercent = 56;
  assert.notEqual(parseRelayServerMessage(valid), null);
  valid.snapshot.activeThreadKey = "local:00000000-0000-4000-8000-000000000000";
  valid.snapshot.activeThreadTitle = "Build the iPhone companion";
  assert.notEqual(parseRelayServerMessage(valid), null);
  valid.snapshot.usage = {
    windows: [{ id: "weekly", kind: "weekly", usedPercent: 35, remainingPercent: 65, windowDurationMins: 10_080, resetsAt: 1_800_000_000_000 }],
    observedAt: 1_700_000_000_000,
    resetCreditsAvailable: 1,
    resetCreditsApplicable: 0
  };
  assert.notEqual(parseRelayServerMessage(valid), null);
  const invalidUsage = structuredClone(valid);
  invalidUsage.snapshot.usage!.windows[0]!.remainingPercent = 101;
  assert.equal(parseRelayServerMessage(invalidUsage), null);
  valid.snapshot.activeThreadKey = "local:not-a-thread";
  assert.equal(parseRelayServerMessage(valid), null);
  valid.snapshot.activeThreadKey = "local:00000000-0000-4000-8000-000000000000";
  valid.snapshot.activeThreadTitle = "x".repeat(241);
  assert.equal(parseRelayServerMessage(valid), null);
  delete valid.snapshot.activeThreadTitle;
  delete valid.snapshot.activeThreadKey;
  const invalidRevision = structuredClone(valid);
  invalidRevision.snapshot.hostSessions![0]!.completionRevision = -1;
  assert.equal(parseRelayServerMessage(invalidRevision), null);
  const invalidContext = structuredClone(valid);
  invalidContext.snapshot.slots[0]!.contextUsedPercent = 101;
  assert.equal(parseRelayServerMessage(invalidContext), null);
  const invalid = structuredClone(valid) as typeof valid & { snapshot: { hostSessions: unknown[] } };
  invalid.snapshot.hostSessions = Array.from({ length: 129 }, () => valid.snapshot.hostSessions![0]!);
  assert.equal(parseRelayServerMessage(invalid), null);
  assert.notEqual(parseRelayServerMessage({
    type: "health", protocol: 1, host, state: "degraded",
    reason: "native-signals-unavailable", observedAt: 2
  }), null);
  assert.equal(parseRelayServerMessage({
    type: "health", protocol: 1, host, state: "offline",
    reason: "native-signals-unavailable", observedAt: 2
  }), null);
});

test("relay parser rejects malformed snapshot fields before activity merge", () => {
  const makePacket = () => ({
    type: "snapshot", protocol: 1, host: structuredClone(host), observedAt: 2_000,
    snapshot: structuredClone(snapshot)
  });
  const invalid: unknown[] = [];
  const add = (mutate: (packet: ReturnType<typeof makePacket>) => void): void => {
    const packet = makePacket();
    mutate(packet);
    invalid.push(packet);
  };
  add((packet) => { packet.snapshot.slots[0]!.threadKey = {} as unknown as string; });
  add((packet) => { packet.snapshot.slots[0]!.title = 7 as unknown as string; });
  add((packet) => { packet.snapshot.slots[0]!.title = "x".repeat(241); });
  add((packet) => { packet.snapshot.slots[0]!.status = "x".repeat(65); });
  add((packet) => { packet.snapshot.slots[0]!.selected = "yes" as unknown as boolean; });
  add((packet) => { packet.snapshot.slots[0]!.activityAt = 0; });
  add((packet) => { packet.snapshot.slots[0]!.activityAt = 1e308; });
  add((packet) => { packet.snapshot.slots[0]!.ownedByHost = "yes" as unknown as boolean; });
  add((packet) => { packet.snapshot.layout.version = 2 as 1; });
  add((packet) => { packet.snapshot.layout.slots.ACT06 = { keycapId: "" }; });
  add((packet) => { packet.snapshot.layout.slots.ACT06 = { keycapId: "x".repeat(65) }; });
  add((packet) => { packet.snapshot.layout.slots.ACT06 = { keycapId: "FAST", commandId: "x".repeat(129) }; });
  add((packet) => { packet.snapshot.layout.analogStick = [] as unknown as MicroSnapshot["layout"]["analogStick"]; });
  add((packet) => { packet.snapshot.agentSource = "random" as MicroSnapshot["agentSource"]; });
  add((packet) => { packet.snapshot.lightingAutoOff = "x".repeat(65); });
  add((packet) => { packet.snapshot.theme = "sepia" as MicroSnapshot["theme"]; });
  add((packet) => { packet.observedAt = 0; });
  add((packet) => { packet.observedAt = 1e308; });
  add((packet) => { packet.snapshot.activeThreadKey = null as unknown as string; });
  add((packet) => { packet.snapshot.activeThreadTitle = null as unknown as string; });
  add((packet) => { packet.snapshot.reasoningEffort = null as unknown as string; });
  add((packet) => { packet.snapshot.fastModeEnabled = null as unknown as boolean; });
  add((packet) => { packet.snapshot.usage = null as unknown as NonNullable<MicroSnapshot["usage"]>; });
  add((packet) => { packet.snapshot.hostSessions = null as unknown as NonNullable<MicroSnapshot["hostSessions"]>; });
  add((packet) => { packet.snapshot.usage = {
    windows: [], observedAt: 1e308, resetCreditsAvailable: null, resetCreditsApplicable: null
  }; });
  add((packet) => { packet.snapshot.usage = {
    windows: [], observedAt: 2_000, resetCreditsAvailable: null
  } as unknown as NonNullable<MicroSnapshot["usage"]>; });
  add((packet) => { packet.snapshot.usage = {
    windows: [{ id: "weekly", kind: "weekly", usedPercent: 1, remainingPercent: 99, windowDurationMins: 1e308, resetsAt: null }],
    observedAt: 2_000, resetCreditsAvailable: null, resetCreditsApplicable: null
  }; });
  add((packet) => { packet.snapshot.hostSessions = [{
    threadId: packet.snapshot.slots[0]!.threadKey!, activityAt: 1e308, status: "working"
  }]; });
  add((packet) => { packet.snapshot.hostSessions = [{
    threadId: packet.snapshot.slots[0]!.threadKey!, activityAt: 2_000, status: "working",
    completionRevision: null as unknown as number
  }]; });

  for (const packet of invalid) assert.equal(parseRelayServerMessage(packet), null);
  const fractionalProducerPacket = makePacket();
  fractionalProducerPacket.observedAt = 2_000.5;
  fractionalProducerPacket.snapshot.slots[0]!.activityAt = 1_000.5;
  fractionalProducerPacket.snapshot.hostSessions = [{
    threadId: fractionalProducerPacket.snapshot.slots[0]!.threadKey!, activityAt: 1_500.5, status: "working"
  }];
  fractionalProducerPacket.snapshot.usage = {
    windows: [{
      id: "other", kind: "other", usedPercent: 1, remainingPercent: 99,
      windowDurationMins: 2.5, resetsAt: 3_000.5
    }],
    observedAt: 2_000.5, resetCreditsAvailable: null, resetCreditsApplicable: null
  };
  assert.notEqual(parseRelayServerMessage(fractionalProducerPacket), null);
  const accepted = invalid.flatMap((packet) => {
    const parsed = parseRelayServerMessage(packet);
    return parsed?.type === "snapshot"
      ? [{ host: parsed.host, snapshot: parsed.snapshot, observedAt: parsed.observedAt }]
      : [];
  });
  assert.deepEqual(new HostActivityIndex().merge(accepted, 2_000, host.hostId), []);
});

test("relay parser bounds host identity and ready capabilities", () => {
  const ready = {
    type: "ready", protocol: 1, host: structuredClone(host),
    capabilities: ["usage-refresh"], bridge: "native-codex-micro"
  };
  assert.notEqual(parseRelayServerMessage(ready), null, "mixed-version peers may omit capabilities or reasoning only");
  for (const invalid of [
    { ...ready, host: { ...host, hostId: "" } },
    { ...ready, host: { ...host, hostId: "x".repeat(129) } },
    { ...ready, host: { ...host, hostName: "   " } },
    { ...ready, host: { ...host, hostName: "x".repeat(129) } },
    { ...ready, host: { ...host, codexVersion: null } },
    { ...ready, capabilities: Array.from({ length: 33 }, (_, index) => `cap-${index}`) },
    { ...ready, capabilities: null },
    { ...ready, capabilities: [""] },
    { ...ready, capabilities: ["x".repeat(65)] },
    { ...ready, bridge: "arbitrary-evaluate" },
    { ...ready, bridge: null }
  ]) assert.equal(parseRelayServerMessage(invalid), null);
  const legacy = { ...ready } as { capabilities?: string[] };
  delete legacy.capabilities;
  assert.notEqual(parseRelayServerMessage(legacy), null);
  assert.equal(parseRelayServerMessage({
    type: "result", protocol: 1, requestId: "request", ok: false, error: null
  }), null);
});

test("relay result parser accepts only typed successful outcomes and exact result shapes", () => {
  const success = { type: "result", protocol: 1, requestId: "request", ok: true };
  assert.deepEqual(parseRelayServerMessage(success), success);
  for (const outcome of ["applied", "blocked-ultra"] as const) {
    const result = { ...success, outcome };
    assert.deepEqual(parseRelayServerMessage(result), result);
  }
  const failure = { type: "result", protocol: 1, requestId: "request", ok: false, error: "failed" };
  assert.deepEqual(parseRelayServerMessage(failure), failure);
  assert.deepEqual(parseRelayServerMessage({ ...failure, error: undefined }), { ...failure, error: undefined });

  for (const invalid of [
    { ...success, outcome: "unknown" },
    { ...success, outcome: null },
    { ...success, outcome: 1 },
    { ...success, outcome: {} },
    { ...failure, outcome: "blocked-ultra" },
    { ...success, error: "success cannot carry an error" },
    { ...success, requestId: "" },
    { ...success, requestId: "x".repeat(129) },
    { ...failure, error: "x".repeat(513) },
    { ...success, extra: true }
  ]) {
    assert.equal(parseRelayServerMessage(invalid), null, JSON.stringify(invalid));
  }
});

test("relay result parsing accepts only exact own data properties without invoking getters", () => {
  let getterReads = 0;
  const resultCases = [
    [{ type: "result", protocol: 1, requestId: "request", ok: true, outcome: "applied" }, "type", "result"],
    [{ type: "result", protocol: 1, requestId: "request", ok: true, outcome: "applied" }, "outcome", "applied"],
    [{ type: "result", protocol: 1, requestId: "request", ok: false, error: "failed" }, "error", "failed"]
  ] as const;
  for (const [base, property, returned] of resultCases) {
    const message = { ...base } as Record<string, unknown>;
    Object.defineProperty(message, property, {
      enumerable: true,
      get() {
        getterReads += 1;
        return returned;
      }
    });
    assert.equal(parseRelayServerMessage(message), null, `${property} getter`);
  }
  const nonEnumerableExtra = {
    type: "result", protocol: 1, requestId: "request", ok: true, outcome: "applied"
  };
  Object.defineProperty(nonEnumerableExtra, "error", { value: "hidden" });
  assert.equal(parseRelayServerMessage(nonEnumerableExtra), null);
  const symbolExtra = {
    type: "result", protocol: 1, requestId: "request", ok: true, outcome: "applied",
    [Symbol("error")]: "hidden"
  };
  assert.equal(parseRelayServerMessage(symbolExtra), null);
  const inheritedOutcome = Object.assign(Object.create({ outcome: "applied" }) as Record<string, unknown>, {
    type: "result", protocol: 1, requestId: "request", ok: true
  });
  assert.equal(parseRelayServerMessage(inheritedOutcome), null);
  const inheritedType = Object.assign(Object.create({
    get type() {
      getterReads += 1;
      return "result";
    }
  }) as Record<string, unknown>, { protocol: 1, requestId: "request", ok: true });
  assert.equal(parseRelayServerMessage(inheritedType), null);
  assert.equal(getterReads, 0);

  assert.deepEqual(
    parseRelayServerMessage(JSON.parse(
      '{"type":"result","protocol":1,"requestId":"request","ok":true,"outcome":"blocked-ultra"}'
    )),
    { type: "result", protocol: 1, requestId: "request", ok: true, outcome: "blocked-ultra" }
  );
});

test("relay snapshot layouts accept official keycaps and reject filesystem-shaped identifiers", () => {
  const packet = {
    type: "snapshot", protocol: 1, host, observedAt: 2_000, snapshot: structuredClone(snapshot)
  };
  packet.snapshot.layout.slots.ACT06.keycapId = "FAST";
  assert.notEqual(parseRelayServerMessage(packet), null);
  for (const keycapId of ["../../secret", "/tmp/secret", "nested/FAST", "..\\secret", "C:\\secret"]) {
    const malicious = structuredClone(packet);
    malicious.snapshot.layout.slots.ACT06.keycapId = keycapId;
    assert.equal(parseRelayServerMessage(malicious), null, keycapId);
  }
});

test("relay health becomes degraded from local receipt age without trusting remote clocks", () => {
  const ready = { state: "ready", changedAt: 900 } as const;
  assert.equal(resolveRelayHealth(ready, true, 1_000, 1_000 + RELAY_SNAPSHOT_STALE_MS).state, "ready");
  assert.deepEqual(resolveRelayHealth(ready, true, 1_000, 1_001 + RELAY_SNAPSHOT_STALE_MS), {
    state: "degraded", reason: "snapshot-stale", changedAt: 1_000
  });
  const offline = { state: "offline", reason: "relay-disconnected", changedAt: 2_000 } as const;
  assert.equal(resolveRelayHealth(offline, true, 1_000, 99_000), offline);
});

test("remote snapshots are normalized to the receiver clock", () => {
  const remote = structuredClone(snapshot);
  remote.hostSessions = [{
    threadId: remote.slots[0]!.threadKey!, activityAt: 970_000,
    status: "working", completionRevision: undefined
  }];
  remote.usage = {
    windows: [{
      id: "weekly", kind: "weekly", usedPercent: 40, remainingPercent: 60,
      windowDurationMins: 10_080, resetsAt: 1_600_000
    }],
    observedAt: 1_000_000,
    resetCreditsAvailable: 1,
    resetCreditsApplicable: 1
  };
  remote.slots[0]!.activityAt = 990_000;

  const normalized = normalizeHostSnapshotAtReceipt(
    { host, snapshot: remote, observedAt: 1_000_000 }, 1_030_000);
  assert.equal(normalized.observedAt, 1_030_000);
  assert.equal(normalized.snapshot.slots[0]!.activityAt, 1_020_000);
  assert.equal(normalized.snapshot.hostSessions![0]!.activityAt, 1_000_000);
  assert.equal(normalized.snapshot.usage!.observedAt, 1_030_000);
  assert.equal(normalized.snapshot.usage!.windows[0]!.resetsAt, 1_630_000);
});

test("clock skew cannot hide a remote owner status or selection", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const threadKey = snapshot.slots[0]!.threadKey!;
  const macMirror = structuredClone(snapshot);
  const windowsOwner = structuredClone(snapshot);
  macMirror.slots[0]!.status = "idle";
  macMirror.slots[0]!.selected = false;
  macMirror.slots[0]!.ownedByHost = false;
  windowsOwner.slots[0]!.status = "working";
  windowsOwner.slots[0]!.selected = true;
  windowsOwner.slots[0]!.ownedByHost = true;
  windowsOwner.hostSessions = [{
    threadId: threadKey, activityAt: 995_000, status: "working", completionRevision: undefined
  }];
  const normalizedRemote = normalizeHostSnapshotAtReceipt(
    { host: windows, snapshot: windowsOwner, observedAt: 1_000_000 }, 1_030_000);
  const merged = new HostActivityIndex().merge([
    { host, snapshot: macMirror, observedAt: 1_030_000 }, normalizedRemote
  ]);
  const task = merged.find((slot) => slot.threadKey === threadKey)!;
  assert.equal(task.status, "working");
  assert.equal(task.selected, true);
  assert.equal(task.host.hostId, windows.hostId);
});

test("relay suppresses one transient renderer failure after a healthy snapshot", () => {
  assert.equal(relaySnapshotFailureShouldDegrade(false, 1), true, "initial failure has no safe snapshot");
  assert.equal(relaySnapshotFailureShouldDegrade(true, 1), false, "one transient failure keeps last-known state");
  assert.equal(relaySnapshotFailureShouldDegrade(true, 2), true, "repeated failures surface degraded health");
});

test("host activity merge globally orders explicit Mac and Windows timestamps", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const slot of windowsSnapshot.slots) slot.threadKey = `10000000-0000-4000-8000-00000000000${slot.id}`;
  for (const slot of [...macSnapshot.slots, ...windowsSnapshot.slots]) slot.activityAt = 1;
  macSnapshot.slots[0]!.activityAt = 100;
  windowsSnapshot.slots[0]!.activityAt = 200;
  const merged = new HostActivityIndex().merge([
    { host, snapshot: macSnapshot, observedAt: 1_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 }
  ]);
  assert.equal(merged[0]!.host.platform, "win32");
  assert.equal(merged[0]!.sourceSlot, 0);
  assert.ok(merged.some((slot) => slot.host.platform === "darwin"));
});

test("a newly connected host cannot make unknown historical activity look recent", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const slot of [...macSnapshot.slots, ...windowsSnapshot.slots]) {
    delete slot.activityAt;
    slot.status = "idle";
    slot.selected = false;
  }
  windowsSnapshot.slots[0]!.selected = true;
  windowsSnapshot.slots[0]!.status = "working";
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 9_000 }
  ]);
  assert.equal(merged[0]!.host.platform, "win32");
  assert.equal(merged[0]!.threadKey, windowsSnapshot.slots[0]!.threadKey);
  assert.equal(merged[0]!.activityAt, 0);
});

test("an idle cloud thread visible on both hosts keeps the first stable owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const candidate of [macSnapshot.slots[5]!, windowsSnapshot.slots[5]!]) {
    candidate.threadKey = shared;
    candidate.status = "idle";
    candidate.selected = false;
    delete candidate.activityAt;
  }
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 9_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "win32");
});

test("backing rollout ownership beats a mirrored remote-SSH recent entry", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, status: "idle", selected: false, ownedByHost: true };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, status: "working", selected: true, ownedByHost: false };
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "darwin", "commands route to the host with the rollout");
  assert.equal(match?.status, "working", "the strongest mirrored live status remains visible");
  assert.equal(match?.selected, true, "selection is aggregated across both visible mirrors");
});

test("a stale mirrored working state cannot override a fresh idle owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: shared, status: "idle", selected: false, ownedByHost: true
  };
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: shared, status: "working", selected: true, ownedByHost: false
  };
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 7_001 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "darwin", "the backing host still receives commands");
  assert.equal(match?.status, "idle", "fresh native state wins over a stale mirror");
  assert.equal(match?.selected, false, "stale remote selection is not aggregated");
});

test("a recent mirrored working state still augments a fresh idle owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: shared, status: "idle", selected: false, ownedByHost: true
  };
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: shared, status: "working", selected: true, ownedByHost: false
  };
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 3_000 },
    { host, snapshot: macSnapshot, observedAt: 7_001 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.status, "working");
  assert.equal(match?.selected, true);
});

test("host session catalogs route a mirror even when the owning host has no native slot for it", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "40000000-0000-4000-8000-000000000099", status: "idle" };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, title: "Mac-owned task", status: "idle", ownedByHost: false };
  macSnapshot.hostSessions = [{ threadId: shared, activityAt: 2_000, status: "working" }];
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "darwin");
  assert.equal(match?.status, "working");
  assert.equal(match?.title, "Mac-owned task");
});

test("host session catalogs return a Mac-only cloud mirror to its Windows owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, status: "working", ownedByHost: false };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: "40000000-0000-4000-8000-000000000099", status: "idle" };
  windowsSnapshot.hostSessions = [{ threadId: shared, activityAt: 2_000, status: "idle" }];
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "win32");
  assert.equal(match?.status, "working");
});

test("temporary Windows new-thread keys merge with a titleless session-backed Mac mirror", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const temporary = "local:client-new-thread:819699e8-ed6d-46fb-bfd1-3280c028de2b";
  const rollout = "019f804a-4e0a-7b32-bf66-af64a405d2d5";
  const title = "Autocheck 3 Installation prüfen";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "priority";
  macSnapshot.agentSource = "priority";
  windowsSnapshot.activeThreadKey = rollout;
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: temporary, title, status: "idle",
    selected: true, ownedByHost: false
  };
  windowsSnapshot.hostSessions = [
    { threadId: rollout, activityAt: 2_000, status: "working", contextUsedPercent: 59 }
  ];
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: `local:${rollout}`, title: null, status: "working",
    selected: false, ownedByHost: false
  };

  const index = new HostActivityIndex();
  const merged = index.merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  const matches = merged.filter((slot) => slot.title === title);

  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.host.platform, "win32");
  assert.equal(matches[0]!.sourceSlot, 0);
  assert.equal(matches[0]!.threadKey, temporary, "commands keep the live Windows slot key");
  assert.equal(matches[0]!.selected, true);
  assert.equal(matches[0]!.status, "working", "the live mirror status remains visible");
  assert.equal(matches[0]!.contextUsedPercent, 59);

  windowsSnapshot.slots[0]!.selected = false;
  windowsSnapshot.activeThreadKey = "10000000-0000-4000-8000-000000000000";
  const afterSelectionMoves = index.merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 3_000 },
    { host, snapshot: macSnapshot, observedAt: 3_000 }
  ], 3_000, windows.hostId).filter((slot) => slot.threadKey?.endsWith(rollout) || slot.threadKey === temporary);
  assert.equal(afterSelectionMoves.length, 1, "the learned alias survives a later selection change");
  assert.equal(afterSelectionMoves[0]!.title, title);
});

test("a titled mirror supplies the label when the rollout owner is titleless", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const shared = "11000000-0000-4000-8000-000000000000";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: shared, title: "Visible on Windows", ownedByHost: false
  };
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: `local:${shared}`, title: null, ownedByHost: true
  };
  macSnapshot.hostSessions = [{ threadId: shared, activityAt: 2_000, status: "idle" }];

  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  const matches = merged.filter((slot) => slot.threadKey?.endsWith(shared));
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.host.platform, "darwin");
  assert.equal(matches[0]!.title, "Visible on Windows");
});

test("a learned Mac new-thread alias survives a Windows relay reconnect", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const temporary = "local:client-new-thread:12000000-0000-4000-8000-000000000000";
  const rollout = "13000000-0000-4000-8000-000000000000";
  const title = "New Mac task";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "priority";
  macSnapshot.agentSource = "priority";
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: rollout, title: null, status: "working",
    selected: false, ownedByHost: false
  };
  macSnapshot.activeThreadKey = rollout;
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: temporary, title, status: "working",
    selected: true, ownedByHost: false
  };
  macSnapshot.hostSessions = [
    { threadId: rollout, activityAt: 2_000, status: "working", contextUsedPercent: 12 }
  ];
  const index = new HostActivityIndex();
  const inputs = () => [
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ];

  assert.equal(index.merge(inputs(), 2_000, windows.hostId)
    .filter((slot) => slot.threadKey?.endsWith(rollout) || slot.threadKey === temporary).length, 1);
  index.merge([{ host: windows, snapshot: windowsSnapshot, observedAt: 2_500 }], 2_500, windows.hostId);
  macSnapshot.slots[0]!.selected = false;
  macSnapshot.activeThreadKey = "14000000-0000-4000-8000-000000000000";
  const reconnected = index.merge(inputs().map((input) => ({ ...input, observedAt: 3_000 })), 3_000, windows.hostId)
    .filter((slot) => slot.threadKey?.endsWith(rollout) || slot.threadKey === temporary);
  assert.equal(reconnected.length, 1);
  assert.equal(reconnected[0]!.host.platform, "darwin");
  assert.equal(reconnected[0]!.title, title);
  assert.equal(reconnected[0]!.contextUsedPercent, 12);
});

test("delayed mirror status does not reorder an owned active task", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const slot of [...macSnapshot.slots, ...windowsSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    delete slot.activityAt;
  }
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, ownedByHost: true };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, ownedByHost: false };
  const index = new HostActivityIndex();
  index.merge([
    { host, snapshot: macSnapshot, observedAt: 500 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 500 }
  ]);

  macSnapshot.slots[0]!.status = "working";
  macSnapshot.slots[0]!.selected = true;
  let match = index.merge([
    { host, snapshot: macSnapshot, observedAt: 1_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.activityAt, 1_000);

  windowsSnapshot.slots[0]!.status = "working";
  windowsSnapshot.slots[0]!.selected = true;
  match = index.merge([
    { host, snapshot: macSnapshot, observedAt: 2_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.activityAt, 1_000, "the delayed non-owner mirror cannot refresh recency");
});

test("the same cloud thread is shown once and owned by its live active host", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  const shared = "00000000-0000-4000-8000-000000000000";
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, status: "working", activityAt: 100 };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, status: "idle", activityAt: 200 };
  const index = new HostActivityIndex();
  const merged = index.merge([
    { host, snapshot: macSnapshot, observedAt: 1_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 }
  ]);
  const matches = merged.filter((slot) => slot.threadKey === shared);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.host.platform, "darwin");
  assert.equal(matches[0]!.status, "working");

  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, status: "idle" };
  const afterCompletion = index.merge([
    { host, snapshot: macSnapshot, observedAt: 2_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(afterCompletion?.host.platform, "darwin", "the host that completed the task retains ownership");
});

test("single-host agent modes preserve Codex's native six-slot order", () => {
  const pinned = structuredClone(snapshot);
  pinned.agentSource = "pinned";
  for (const slot of pinned.slots) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = slot.id;
  }
  const merged = new HostActivityIndex().merge([{ host, snapshot: pinned, observedAt: 1_000 }], 1_000, host.hostId);
  assert.deepEqual(merged.map((slot) => slot.threadKey), pinned.slots.map((slot) => slot.threadKey));
  assert.deepEqual(merged.map((slot) => slot.id), [0, 1, 2, 3, 4, 5]);
});

test("combined pinned mode interleaves both hosts and routes mirrored tasks to the owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "20000000-0000-4000-8000-000000000000";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "pinned";
  macSnapshot.agentSource = "pinned";
  for (const slot of windowsSnapshot.slots) slot.threadKey = `21000000-0000-4000-8000-00000000000${slot.id}`;
  for (const slot of macSnapshot.slots) slot.threadKey = `22000000-0000-4000-8000-00000000000${slot.id}`;
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, ownedByHost: false };
  macSnapshot.slots[4] = { ...macSnapshot.slots[4]!, threadKey: shared, ownedByHost: true };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, shared);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.sourceSlot, 4);
  assert.deepEqual(merged.slice(1).map((slot) => slot.threadKey), [
    macSnapshot.slots[0]!.threadKey,
    windowsSnapshot.slots[1]!.threadKey,
    macSnapshot.slots[1]!.threadKey,
    windowsSnapshot.slots[2]!.threadKey,
    macSnapshot.slots[2]!.threadKey
  ]);
});

test("combined custom mode uses the remote assignment when the controller slot is empty", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "custom";
  macSnapshot.agentSource = "custom";
  windowsSnapshot.slots[0] = { id: 0, threadKey: null, title: null, status: "off", selected: false };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "30000000-0000-4000-8000-000000000000", ownedByHost: true };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, macSnapshot.slots[0]!.threadKey);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.sourceSlot, 0);
});

test("combined custom mode keeps the controller assignment when both hosts configure one button", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "custom";
  macSnapshot.agentSource = "custom";
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: "31000000-0000-4000-8000-000000000000" };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "32000000-0000-4000-8000-000000000000" };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, windowsSnapshot.slots[0]!.threadKey);
  assert.equal(merged[0]!.host.platform, "win32");
});

test("combined custom mode de-duplicates prefixed mirrors and routes them to the rollout owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "custom";
  macSnapshot.agentSource = "custom";
  const id = "33000000-0000-4000-8000-000000000000";
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: `local:${id}`, ownedByHost: false };
  macSnapshot.slots[1] = { ...macSnapshot.slots[1]!, threadKey: `local:client-new-thread:${id}`, ownedByHost: true };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged.filter((slot) => slot.threadKey?.endsWith(id)).length, 1);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.sourceSlot, 1);
  assert.equal(merged[1]!.threadKey, windowsSnapshot.slots[1]!.threadKey);
});

test("combined priority mode ranks waiting, unread, active, then idle", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "priority";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = 1;
  }
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "40000000-0000-4000-8000-000000000000", status: "working" };
  macSnapshot.slots[1] = { ...macSnapshot.slots[1]!, threadKey: "40000000-0000-4000-8000-000000000001", status: "unread" };
  macSnapshot.slots[2] = { ...macSnapshot.slots[2]!, threadKey: "40000000-0000-4000-8000-000000000002", status: "awaiting-approval" };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.deepEqual(merged.slice(0, 3).map((slot) => slot.status), ["awaiting-approval", "unread", "working"]);
});

test("combined priority mode keeps freshly completed owner sessions ahead of idle tasks", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const completed = "50000000-0000-4000-8000-000000000000";
  windowsSnapshot.agentSource = "priority";
  macSnapshot.agentSource = "priority";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = 1;
  }
  windowsSnapshot.slots[4] = { ...windowsSnapshot.slots[4]!, threadKey: completed, status: "idle" };
  macSnapshot.hostSessions = [{ threadId: completed, activityAt: 2_000, status: "complete" }];
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, completed);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.status, "complete");
});

test("a completion opened through a cross-host mirror stays idle until a new completion revision", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const completed = "50000000-0000-4000-8000-000000000001";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = 1;
  }
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: "50000000-0000-4000-8000-000000000099" };
  windowsSnapshot.activeThreadKey = `local:${completed}`;
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: completed, ownedByHost: true };
  macSnapshot.hostSessions = [{ threadId: completed, activityAt: 1_900, status: "working" }];
  const index = new HostActivityIndex();
  const inputs = () => [
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ];

  assert.equal(index.merge(inputs(), 2_000, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "working");
  macSnapshot.hostSessions[0] = { threadId: completed, activityAt: 2_000, status: "complete", completionRevision: 10 };
  assert.equal(index.merge(inputs(), 2_001, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "idle");
  delete windowsSnapshot.activeThreadKey;
  index.merge(inputs(), 2_002, windows.hostId);
  windowsSnapshot.activeThreadKey = `local:${completed}`;
  assert.equal(index.merge(inputs(), 2_003, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "idle");
  delete windowsSnapshot.activeThreadKey;
  assert.equal(index.merge(inputs(), 2_004, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "idle");

  macSnapshot.hostSessions[0]!.completionRevision = 20;
  assert.equal(index.merge(inputs(), 2_005, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "complete");
  macSnapshot.slots[0]!.status = "working";
  assert.equal(index.merge(inputs(), 2_006, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "working");
});

test("host lifecycle preserves fresh native approval attention", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const threadId = "50000000-0000-4000-8000-000000000003";
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: threadId, status: "working" };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: threadId, status: "awaiting-approval", ownedByHost: true };
  macSnapshot.hostSessions = [{ threadId, activityAt: 2_000, status: "idle" }];
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  assert.equal(merged.find((slot) => slot.threadKey === threadId)?.status, "awaiting-approval");
});

test("an old session completion cannot resurrect a current native idle slot", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const completed = "50000000-0000-4000-8000-000000000002";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
  }
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: completed, ownedByHost: false };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: completed, ownedByHost: true };
  macSnapshot.hostSessions = [{
    threadId: completed, activityAt: 1_000, status: "complete", completionRevision: 10
  }];
  const observedAt = 1_000 + 5 * 60_000 + 1;
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt },
    { host, snapshot: macSnapshot, observedAt }
  ], observedAt, windows.hostId);

  assert.equal(merged.find((slot) => slot.threadKey === completed)?.status, "idle");
});

test("authenticated relay publishes snapshots and dispatches typed commands", async () => {
  const port = await freePort();
  const calls: unknown[] = [];
  const control = {
    refresh: async () => snapshot,
    sendAgent: async (slot: number, act: 0 | 1) => { calls.push(["agent", slot, act]); },
    sendAction: async () => {}, sendJoystick: async () => {}, sendEncoder: async () => {},
    adjustReasoning: async () => ({ outcome: "applied" as const }), runKeycap: async () => {}, consumeRateLimitReset: async () => {},
    refreshUsage: async () => { calls.push(["usage-refresh"]); }
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "t".repeat(32) }));
  const first = await messages.next();
  assert.equal(first.type, "ready");
  assert.equal(first.bridge, "native-codex-micro");
  assert.deepEqual(first.capabilities, [
    "agent", "action", "joystick", "encoder", "reasoning", "reasoning-policy", "keycap", "usage",
    "usage-refresh", "rate-limit-reset"
  ]);
  const second = await messages.next();
  assert.equal(second.type, "snapshot");
  socket.send(JSON.stringify({
    type: "command", protocol: RELAY_PROTOCOL_VERSION, requestId: "request-1",
    command: { kind: "agent", slot: 2, threadKey: "00000000-0000-4000-8000-000000000002", act: 1 }
  }));
  const result = await messages.next();
  assert.deepEqual(calls, [["agent", 2, 1]]);
  assert.equal(result.type, "result");
  assert.equal(result.ok, true);
  socket.send(JSON.stringify({
    type: "command", protocol: RELAY_PROTOCOL_VERSION, requestId: "request-2",
    command: { kind: "usage-refresh" }
  }));
  let refreshResult = await messages.next();
  while (refreshResult.type !== "result" || refreshResult.requestId !== "request-2") {
    refreshResult = await messages.next();
  }
  assert.deepEqual(calls, [["agent", 2, 1], ["usage-refresh"]]);
  assert.equal(refreshResult.type, "result");
  assert.equal(refreshResult.ok, true);
  socket.close();
  await server.close();
});

test("relay client and server round-trip typed reasoning outcomes without inventing non-reasoning results", async (t) => {
  const port = await freePort();
  const policies: unknown[] = [];
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {},
    adjustReasoning: async (_direction: string, policy?: { includeUltra: boolean }) => {
      policies.push(policy);
      return { outcome: policy?.includeUltra ? "applied" as const : "blocked-ultra" as const };
    },
    runKeycap: async () => {}, consumeRateLimitReset: async () => {}, refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    await server.close();
  });
  await server.start();
  client.start();
  await waitUntil(() => client.currentHealth().state === "ready");

  assert.equal(await client.send({
    kind: "reasoning", direction: "increase", includeUltra: true
  }), "applied");
  assert.equal(await client.send({
    kind: "reasoning", direction: "increase", includeUltra: false
  }), "blocked-ultra");
  assert.equal(await client.send({ kind: "action", slot: "ACT06", act: 1 }), undefined);
  assert.deepEqual(policies, [{ includeUltra: true }, { includeUltra: false }]);
});

test("relay server fails closed when a reasoning control returns an invalid outcome", async (t) => {
  const port = await freePort();
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => "unexpected" as never,
    runKeycap: async () => {}, consumeRateLimitReset: async () => {}, refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(async () => {
    socket.close();
    await server.close();
  });
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: 1, token: "t".repeat(32) }));
  assert.equal((await messages.next()).type, "ready");
  assert.equal((await messages.next()).type, "snapshot");
  socket.send(JSON.stringify({
    type: "command", protocol: 1, requestId: "invalid-outcome",
    command: { kind: "reasoning", direction: "increase", includeUltra: true }
  }));

  const result = await messages.next();
  assert.equal(result.type, "result");
  assert.equal(result.ok, false);
  assert.equal("outcome" in result, false);
  assert.match(String(result.error), /invalid reasoning adjustment result/i);
});

test("relay client receives an error when a reasoning control omits its mandatory outcome", async (t) => {
  const port = await freePort();
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => undefined as never,
    runKeycap: async () => {}, consumeRateLimitReset: async () => {}, refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    await server.close();
  });
  await server.start();
  client.start();
  await waitUntil(() => client.currentHealth().state === "ready");

  await assert.rejects(client.send({
    kind: "reasoning", direction: "increase", includeUltra: true
  }), /invalid reasoning adjustment result/i);
});

test("relay client rejects an outcome-less reasoning success from a malformed peer", async (t) => {
  const port = await freePort();
  const relay = new WebSocketServer({ host: "127.0.0.1", port });
  relay.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "ready", protocol: 1, host,
          capabilities: ["action", "reasoning", "reasoning-policy"], bridge: "native-codex-micro"
        }));
        socket.send(JSON.stringify({
          type: "snapshot", protocol: 1, host, observedAt: Date.now(), snapshot
        }));
      } else if (message.type === "command") {
        socket.send(JSON.stringify({
          type: "result", protocol: 1, requestId: message.requestId, ok: true
        }));
      }
    });
  });
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  client.start();
  await waitUntil(() => client.currentHealth().state === "ready");

  await assert.rejects(client.send({
    kind: "reasoning", direction: "increase", includeUltra: true
  }), /invalid reasoning adjustment result/i);
  assert.equal(await client.send({ kind: "action", slot: "ACT06", act: 1 }), undefined);
});

test("relay client refuses restricted reasoning before sending to a legacy v1 peer", async (t) => {
  const port = await freePort();
  const relay = new WebSocketServer({ host: "127.0.0.1", port });
  let commandFrames = 0;
  let sideEffects = 0;
  relay.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "ready", protocol: 1, host,
          capabilities: ["reasoning"], bridge: "native-codex-micro"
        }));
      } else if (message.type === "command") {
        commandFrames += 1;
        sideEffects += 1;
        socket.send(JSON.stringify({
          type: "result", protocol: 1, requestId: message.requestId, ok: true
        }));
      }
    });
  });
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  client.start();
  await waitUntil(() => client.supportsCapability("reasoning"));

  await assert.rejects(client.send({
    kind: "reasoning", direction: "increase", includeUltra: false
  }), /reasoning policy/i);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(commandFrames, 0);
  assert.equal(sideEffects, 0);
});

test("relay client maps an outcome-less unrestricted reasoning success from a legacy v1 peer", async (t) => {
  const port = await freePort();
  const relay = new WebSocketServer({ host: "127.0.0.1", port });
  let commandFrames = 0;
  relay.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "ready", protocol: 1, host,
          capabilities: ["reasoning"], bridge: "native-codex-micro"
        }));
      } else if (message.type === "command") {
        commandFrames += 1;
        socket.send(JSON.stringify({
          type: "result", protocol: 1, requestId: message.requestId, ok: true
        }));
      }
    });
  });
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  client.start();
  await waitUntil(() => client.supportsCapability("reasoning"));

  assert.equal(await client.send({
    kind: "reasoning", direction: "increase", includeUltra: true
  }), "applied");
  assert.equal(commandFrames, 1);
});

test("usage refresh publishes a new post-command snapshot before acknowledging success", async (t) => {
  const port = await freePort();
  let refreshCall = 0;
  let usageRefreshes = 0;
  let releasePreCommand!: (value: MicroSnapshot) => void;
  const preCommand = new Promise<MicroSnapshot>((resolve) => { releasePreCommand = resolve; });
  const control = {
    refresh: async () => {
      refreshCall += 1;
      if (refreshCall === 2) return preCommand;
      return { ...structuredClone(snapshot), reasoningEffort: `snapshot-${refreshCall}` };
    },
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => ({ outcome: "applied" as const }), runKeycap: async () => {},
    consumeRateLimitReset: async () => {}, refreshUsage: async () => { usageRefreshes += 1; }
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const commandSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  const commandMessages = messageQueue(commandSocket);
  await onceOpen(commandSocket);
  commandSocket.send(JSON.stringify({ type: "auth", protocol: 1, token: "t".repeat(32) }));
  assert.equal((await commandMessages.next()).type, "ready");
  assert.equal((await commandMessages.next()).type, "snapshot");

  const blockingSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(async () => {
    commandSocket.close();
    blockingSocket.close();
    await server.close();
  });
  const blockingMessages = messageQueue(blockingSocket);
  await onceOpen(blockingSocket);
  blockingSocket.send(JSON.stringify({ type: "auth", protocol: 1, token: "t".repeat(32) }));
  assert.equal((await blockingMessages.next()).type, "ready");
  await waitUntil(() => refreshCall === 2);

  commandSocket.send(JSON.stringify({
    type: "command", protocol: 1, requestId: "fresh-usage",
    command: { kind: "usage-refresh" }
  }));
  await waitUntil(() => usageRefreshes === 1);
  releasePreCommand({ ...structuredClone(snapshot), reasoningEffort: "pre-command" });

  const fresh = await commandMessages.next();
  const result = await commandMessages.next();
  assert.equal(refreshCall, 3, "post-command publication must force a new snapshot");
  assert.equal(fresh.type, "snapshot");
  assert.equal((fresh.snapshot as MicroSnapshot).reasoningEffort, "snapshot-3");
  assert.equal(result.type, "result");
  assert.equal(result.requestId, "fresh-usage");
  assert.equal(result.ok, true);
});

test("running relay publishes refreshed Codex metadata without changing host identity", async () => {
  const port = await freePort();
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => ({ outcome: "applied" as const }), runKeycap: async () => {}, consumeRateLimitReset: async () => {},
    refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) },
    { ...host, codexVersion: "old" }, control, () => {}
  );
  await server.start();
  server.updateHost({ ...host, hostName: "Renamed Mac", codexVersion: "new" });
  assert.throws(
    () => server.updateHost({ ...host, hostId: "56fd97ad-7073-42cc-85ce-befa17546d7d" }),
    /identity cannot change/
  );
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "t".repeat(32) }));
  const ready = await messages.next();
  const readyHost = ready.host as CodexHost;
  assert.equal(readyHost.hostName, "Renamed Mac");
  assert.equal(readyHost.codexVersion, "new");
  const published = await messages.next();
  assert.equal((published.host as CodexHost).codexVersion, "new");
  socket.close();
  await server.close();
});

test("relay rejects a client with the wrong token before publishing state", async () => {
  const port = await freePort();
  let refreshes = 0;
  const control = {
    refresh: async () => { refreshes += 1; return snapshot; },
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => ({ outcome: "applied" as const }), runKeycap: async () => {}, consumeRateLimitReset: async () => {},
    refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "wrong-token".repeat(4) }));
  const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve));
  assert.equal(closeCode, 4003);
  assert.equal(refreshes, 0);
  await server.close();
});

test("authenticated relay survives an unavailable Codex snapshot", async () => {
  const port = await freePort();
  const logs: string[] = [];
  const control = {
    refresh: async (): Promise<MicroSnapshot> => { throw new Error("bridge offline"); },
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => ({ outcome: "applied" as const }), runKeycap: async () => {}, consumeRateLimitReset: async () => {},
    refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control,
    (message) => logs.push(message)
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "t".repeat(32) }));
  assert.equal((await messages.next()).type, "ready");
  const health = await messages.next();
  assert.equal(health.type, "health");
  assert.equal(health.state, "degraded");
  assert.equal(health.reason, "native-signals-unavailable");
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(logs.filter((message) => message.includes("bridge offline")).length, 1);
  socket.close();
  await server.close();
});

test("relay client preserves last-known tasks but marks their host offline after disconnect", async () => {
  const port = await freePort();
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => ({ outcome: "applied" as const }), runKeycap: async () => {}, consumeRateLimitReset: async () => {},
    refreshUsage: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const deliveredSnapshots: HostSnapshot[] = [];
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) },
    (value) => deliveredSnapshots.push(value), () => {}
  );
  client.start();
  await waitUntil(() => client.currentHealth().state === "ready");
  assert.equal(client.supportsCapability("usage-refresh"), true);
  assert.equal(client.supportsCapability("arbitrary-evaluate"), false);
  assert.equal(deliveredSnapshots.length, 1);
  const lastKnown = client.currentSnapshot();
  assert.equal(lastKnown?.snapshot.slots[0]?.title, "Task 1");
  await server.close();
  await waitUntil(() => client.currentHealth().state === "offline");
  assert.equal(deliveredSnapshots.length, 1, "health-only transitions must not call the snapshot callback");
  assert.equal(client.currentSnapshot(), lastKnown);
  assert.equal(client.isConnected(), false);
  assert.equal(client.supportsCapability("usage-refresh"), false);
  client.close();
});

test("relay capabilities are valid only for a snapshot from the current connection generation", async (t) => {
  const port = await freePort();
  const relay = new WebSocketServer({ host: "127.0.0.1", port });
  let connectionCount = 0;
  let firstSocket: WebSocket | undefined;
  let secondSocket: WebSocket | undefined;
  relay.on("connection", (socket) => {
    connectionCount += 1;
    const connection = connectionCount;
    if (connection === 1) firstSocket = socket;
    else secondSocket = socket;
    socket.once("message", () => {
      socket.send(JSON.stringify({
        type: "ready", protocol: 1, host, capabilities: ["usage-refresh"], bridge: "native-codex-micro"
      }));
      if (connection === 1) socket.send(JSON.stringify({
        type: "snapshot", protocol: 1, host, observedAt: Date.now(), snapshot
      }));
    });
  });
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  client.start();
  await waitUntil(() => client.currentHealth().state === "ready");
  const generationGate = client as CodexRelayClient & {
    supportsCapabilityForSnapshot(capability: string, hostId: string): boolean;
  };
  assert.equal(generationGate.supportsCapabilityForSnapshot("usage-refresh", host.hostId), true);

  firstSocket!.close();
  await waitUntil(() => connectionCount === 2, 4_000);
  await waitUntil(() => client.currentHealth().state === "degraded");
  assert.equal(client.currentSnapshot()?.host.hostId, host.hostId, "last-known snapshot stays available for display");
  assert.equal(generationGate.supportsCapabilityForSnapshot("usage-refresh", host.hostId), false);

  secondSocket!.send(JSON.stringify({
    type: "snapshot", protocol: 1, host, observedAt: Date.now(), snapshot
  }));
  await waitUntil(() => generationGate.supportsCapabilityForSnapshot("usage-refresh", host.hostId));
  assert.equal(generationGate.supportsCapabilityForSnapshot("usage-refresh", host.hostId), true);
  assert.equal(generationGate.supportsCapabilityForSnapshot("usage-refresh", "wrong-host"), false);
});

test("relay commands require the current ready identity but remain available while that host is degraded", async (t) => {
  const port = await freePort();
  const relay = new WebSocketServer({ host: "127.0.0.1", port });
  const received: Array<Array<Record<string, unknown>>> = [];
  const sockets: WebSocket[] = [];
  relay.on("connection", (socket) => {
    const connection = received.length;
    received.push([]);
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      received[connection]!.push(message);
      if (message.type === "auth" && connection === 0) {
        socket.send(JSON.stringify({
          type: "ready", protocol: 1, host, capabilities: ["action"], bridge: "native-codex-micro"
        }));
      }
      if (message.type === "command") {
        socket.send(JSON.stringify({
          type: "result", protocol: 1, requestId: message.requestId, ok: true
        }));
      }
    });
  });
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  t.after(async () => {
    client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  client.start();
  await waitUntil(() => client.supportsCapability("action"));
  sockets[0]!.close();
  await waitUntil(() => client.currentHealth().state === "offline");
  await (client as unknown as { connect(): Promise<void> }).connect();
  await waitUntil(() => received[1]?.length === 1);

  await assert.rejects(client.send({ kind: "action", slot: "ACT06", act: 1 }), /offline/);
  assert.equal(received[1]!.length, 1, "an opened reconnect must send only auth before ready");

  sockets[1]!.send(JSON.stringify({
    type: "ready", protocol: 1, host, capabilities: ["action"], bridge: "native-codex-micro"
  }));
  await waitUntil(() => client.supportsCapability("action"));
  await client.send({ kind: "action", slot: "ACT06", act: 1 });
  assert.equal(received[1]!.filter(({ type }) => type === "command").length, 1);

  sockets[1]!.send(JSON.stringify({
    type: "health", protocol: 1, host, state: "degraded",
    reason: "native-signals-unavailable", observedAt: Date.now()
  }));
  await waitUntil(() => client.currentHealth().reason === "native-signals-unavailable");
  await client.send({ kind: "action", slot: "ACT06", act: 0 });
  assert.equal(received[1]!.filter(({ type }) => type === "command").length, 2);
});

test("relay ready host identity is immutable within one connection generation", async (t) => {
  const port = await freePort();
  const relay = new WebSocketServer({ host: "127.0.0.1", port });
  const otherHost: CodexHost = {
    ...host, hostId: "66fd97ad-7073-42cc-85ce-befa17546d7d", hostName: "Unexpected Host"
  };
  let serverSocket: WebSocket | undefined;
  relay.on("connection", (socket) => {
    serverSocket = socket;
    socket.once("message", () => {
      socket.send(JSON.stringify({
        type: "ready", protocol: 1, host, capabilities: ["usage-refresh"], bridge: "native-codex-micro"
      }));
      socket.send(JSON.stringify({ type: "snapshot", protocol: 1, host, observedAt: Date.now(), snapshot }));
    });
  });
  const delivered: HostSnapshot[] = [];
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) },
    (value) => delivered.push(value), () => {}
  );
  t.after(async () => {
    client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  client.start();
  await waitUntil(() => delivered.length === 1);

  serverSocket!.send(JSON.stringify({
    type: "health", protocol: 1, host: otherHost, state: "degraded",
    reason: "native-signals-unavailable", observedAt: Date.now()
  }));
  serverSocket!.send(JSON.stringify({
    type: "snapshot", protocol: 1, host: otherHost, observedAt: Date.now(),
    snapshot: { ...structuredClone(snapshot), reasoningEffort: "wrong-host" }
  }));
  serverSocket!.send(JSON.stringify({
    type: "ready", protocol: 1, host: otherHost, capabilities: ["usage-refresh"], bridge: "native-codex-micro"
  }));
  serverSocket!.send(JSON.stringify({
    type: "snapshot", protocol: 1, host, observedAt: Date.now(),
    snapshot: { ...structuredClone(snapshot), reasoningEffort: "same-host" }
  }));
  await waitUntil(() => delivered.length === 2);
  assert.equal(client.currentHost()?.hostId, host.hostId);
  assert.equal(client.currentSnapshot()?.host.hostId, host.hostId);
  assert.equal(delivered[1]?.snapshot.reasoningEffort, "same-host");
  assert.equal(client.supportsCapabilityForSnapshot("usage-refresh", host.hostId), true);
  assert.equal(client.supportsCapabilityForSnapshot("usage-refresh", otherHost.hostId), false);
});

test("controller catches relay snapshot display failures", async () => {
  const { DeckController } = await import("../src/controller.js");
  const controller = new DeckController();
  const failure = new Error("relay render failed");
  const state = controller as unknown as {
    refreshDisplay: () => Promise<void>;
    refreshDisplayAfterRelaySnapshot?: () => Promise<void>;
  };
  state.refreshDisplay = async () => { throw failure; };
  assert.equal(typeof state.refreshDisplayAfterRelaySnapshot, "function");
  await assert.doesNotReject(state.refreshDisplayAfterRelaySnapshot!());
});

test("controller refreshes account usage on its source host instead of the selected function host", async () => {
  const source = await readFile(new URL("../src/controller.ts", import.meta.url), "utf8");
  assert.match(source, /async refreshUsage\(\): Promise<void>/);
  assert.match(source, /refreshUsage[\s\S]*const source = this\.accountUsageSource\(\)/);
  assert.match(source, /refreshUsage[\s\S]*this\.microBridge\.requestUsageRefresh\(\)/);
  assert.match(source, /refreshUsage[\s\S]*supportsCapabilityForSnapshot\("usage-refresh", source\.hostId\)/);
  assert.match(source, /refreshUsage[\s\S]*\{ kind: "usage-refresh" \}/);
  assert.match(source, /Remote Codex host does not support usage refresh\./);
  assert.match(source, /refreshUsage: async \(\) => \{[\s\S]*?await this\.refreshLocalUsage\(\);[\s\S]*?mobileSnapshotDirty = false/);
});

test("controller preserves last-known usage and degrades health when forced refresh rejects", async () => {
  const { DeckController } = await import("../src/controller.js");
  const controller = new DeckController();
  const knownSnapshot: HostSnapshot = {
    host,
    observedAt: 1_000,
    snapshot: {
      ...structuredClone(snapshot),
      usage: {
        windows: [], observedAt: 1_000,
        resetCreditsAvailable: null, resetCreditsApplicable: null
      }
    }
  };
  const state = controller as unknown as {
    microBridge: { requestUsageRefresh: () => Promise<MicroSnapshot> };
    localHost: CodexHost;
    localSnapshot: HostSnapshot;
    localHealth: { state: string; changedAt: number; reason?: string };
    refreshDisplay: () => Promise<void>;
  };
  state.microBridge = { requestUsageRefresh: async () => { throw new Error("usage fetch failed"); } };
  state.localHost = host;
  state.localSnapshot = knownSnapshot;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.refreshDisplay = async () => {};

  await assert.rejects(controller.refreshUsage(), /usage fetch failed/);
  assert.equal(state.localSnapshot, knownSnapshot);
  assert.equal(state.localSnapshot.snapshot.usage?.observedAt, 1_000);
  assert.equal(state.localHealth.state, "degraded");
  assert.equal(state.localHealth.reason, "local-bridge-unavailable");
});

test("forced controller usage wins over a pre-command refresh in flight", async () => {
  const { DeckController } = await import("../src/controller.js");
  const controller = new DeckController();
  let releasePreCommand!: (value: MicroSnapshot) => void;
  const preCommand = new Promise<MicroSnapshot>((resolve) => { releasePreCommand = resolve; });
  const forcedSnapshot: MicroSnapshot = {
    ...structuredClone(snapshot),
    reasoningEffort: "forced",
    usage: {
      windows: [{
        id: "five-hour", kind: "five-hour", usedPercent: 20, remainingPercent: 80,
        windowDurationMins: 300, resetsAt: 30_000
      }],
      observedAt: 20_000, resetCreditsAvailable: 1, resetCreditsApplicable: 1
    }
  };
  const state = controller as unknown as {
    microBridge: {
      refresh: () => Promise<MicroSnapshot>;
      requestUsageRefresh: () => Promise<MicroSnapshot>;
    };
    localHost: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: string; changedAt: number; reason?: string };
    refresh: () => Promise<void>;
    refreshDisplay: () => Promise<void>;
  };
  state.microBridge = {
    refresh: async () => preCommand,
    requestUsageRefresh: async () => structuredClone(forcedSnapshot)
  };
  state.localHost = host;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.refreshDisplay = async () => {};

  const olderRefresh = state.refresh();
  await controller.refreshUsage();
  assert.equal(state.localSnapshot?.snapshot.reasoningEffort, "forced");

  releasePreCommand({ ...structuredClone(snapshot), reasoningEffort: "stale-pre-command" });
  await olderRefresh;
  assert.equal(state.localSnapshot?.snapshot.reasoningEffort, "forced");
  assert.equal(state.localSnapshot?.snapshot.usage?.observedAt, 20_000);
  assert.equal(state.localHealth.state, "ready");
});

test("a render failure does not degrade a committed usage refresh", async () => {
  const { DeckController } = await import("../src/controller.js");
  const controller = new DeckController();
  const forcedSnapshot: MicroSnapshot = {
    ...structuredClone(snapshot),
    reasoningEffort: "committed-before-render",
    usage: {
      windows: [{
        id: "five-hour", kind: "five-hour", usedPercent: 20, remainingPercent: 80,
        windowDurationMins: 300, resetsAt: 30_000
      }],
      observedAt: 20_000, resetCreditsAvailable: 1, resetCreditsApplicable: 1
    }
  };
  let renders = 0;
  const renderFailure = new Error("render failed");
  const state = controller as unknown as {
    microBridge: { requestUsageRefresh: () => Promise<MicroSnapshot> };
    localHost: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: string; changedAt: number; reason?: string };
    refreshDisplay: () => Promise<void>;
  };
  state.microBridge = { requestUsageRefresh: async () => structuredClone(forcedSnapshot) };
  state.localHost = host;
  state.localHealth = { state: "ready", changedAt: 1_000 };
  state.refreshDisplay = async () => { renders += 1; throw renderFailure; };

  await assert.rejects(controller.refreshUsage(), renderFailure);
  assert.equal(renders, 1);
  assert.equal(state.localSnapshot?.snapshot.reasoningEffort, "committed-before-render");
  assert.equal(state.localSnapshot?.snapshot.usage?.observedAt, 20_000);
  assert.equal(state.localHealth.state, "ready");
  assert.equal(state.localHealth.reason, undefined);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function onceOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for relay state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageQueue(socket: WebSocket): { next: () => Promise<Record<string, unknown>> } {
  const queued: Record<string, unknown>[] = [];
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(value);
    else queued.push(value);
  });
  return {
    next: () => {
      const value = queued.shift();
      if (value) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for relay message.")), 2_000);
        waiting.push((message) => { clearTimeout(timer); resolve(message); });
      });
    }
  };
}
