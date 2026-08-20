import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("iPhone bundle declares the executable required for device installation", async () => {
  const plist = await readFile(new URL("../ios/Configuration/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>\$\(EXECUTABLE_NAME\)<\/string>/);
  assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
});

test("iPhone key library stays in parity with every relay keycap", async () => {
  const [typescript, swift] = await Promise.all([
    readFile(new URL("../src/keycaps.ts", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Models/KeycapCatalog.swift", import.meta.url), "utf8")
  ]);
  const official = typescript.match(/export const OFFICIAL_KEYCAP_IDS = \[([\s\S]*?)\]/)?.[1]
    ?.match(/"[^"]+"/g)?.map((value) => value.slice(1, -1)) ?? [];
  const mobile = [...swift.matchAll(/\.init\(id: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(mobile, official);
});

test("the six physical iPhone keys are interchangeable and persist locally", async () => {
  const [catalog, store, device] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Models/KeycapCatalog.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/MicroDeviceView.swift", import.meta.url), "utf8")
  ]);
  assert.match(catalog, /case action1[\s\S]*case action4[\s\S]*case wide[\s\S]*case corner/);
  assert.match(catalog, /"ACT06"[\s\S]*"ACT12"/);
  assert.match(store, /mobile-key-assignments/);
  assert.match(store, /func pressDeviceKey\(_ slot: DeviceKeySlot\)/);
  assert.match(device, /LongPressGesture\(minimumDuration: 0\.45\)/);
  assert.match(device, /struct KeycapPickerView/);
});

test("iPhone surfaces adopt native Liquid Glass with an older-iOS fallback", async () => {
  const [theme, dashboard, app, icons] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Design/CodexTheme.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/DashboardView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/CodexDeckMobileApp.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Assets.xcassets/AppIcon.appiconset/Contents.json", import.meta.url),
      "utf8")
  ]);
  assert.match(theme, /#available\(iOS 26\.0, \*\)/);
  assert.match(theme, /glassEffect\(/);
  assert.match(theme, /\.ultraThinMaterial/);
  assert.match(theme, /userInterfaceStyle == \.dark/);
  assert.match(dashboard, /GlassEffectContainer\(spacing: 8\)/);
  assert.doesNotMatch(app, /preferredColorScheme\(\.light\)/);
  assert.match(icons, /"appearance"\s*:\s*"luminosity"/);
  assert.match(icons, /"value"\s*:\s*"dark"/);
});

test("iPhone widget extension embeds five native WidgetKit experiences", async () => {
  const [project, widgets, state, commands, appEntitlements, widgetEntitlements] =
    await Promise.all([
      readFile(new URL("../ios/CodexDeckMobile.xcodeproj/project.pbxproj", import.meta.url), "utf8"),
      readFile(new URL("../ios/CodexDeckWidgets/CodexDeckWidgets.swift", import.meta.url), "utf8"),
      readFile(new URL("../ios/CodexDeckShared/CodexWidgetState.swift", import.meta.url), "utf8"),
      readFile(new URL("../ios/CodexDeckShared/CodexWidgetCommands.swift", import.meta.url), "utf8"),
      readFile(new URL("../ios/Configuration/CodexDeckMobile.entitlements", import.meta.url), "utf8"),
      readFile(new URL("../ios/Configuration/CodexDeckWidgets.entitlements", import.meta.url), "utf8")
    ]);
  assert.match(project, /CodexDeckWidgets\.appex in Embed App Extensions/);
  assert.match(project, /productType = "com\.apple\.product-type\.app-extension"/);
  assert.match(widgets, /CodexCapacityWidget\(\)/);
  assert.match(widgets, /CodexCurrentAgentWidget\(\)/);
  assert.match(widgets, /CodexAgentBoardWidget\(\)/);
  assert.match(widgets, /CodexSingleCommandWidget\(\)/);
  assert.match(widgets, /CodexCommandDeckWidget\(\)/);
  assert.match(widgets, /Button\(intent: RunCodexWidgetCommandIntent/);
  assert.match(widgets, /minHeight: 46/);
  assert.match(widgets, /\.containerBackground\(for: \.widget\)/);
  assert.match(widgets, /\.widgetAccentable\(\)/);
  assert.match(widgets, /@Environment\(\\\.colorScheme\)/);
  assert.match(state, /WidgetCenter\.shared\.reloadAllTimelines\(\)/);
  assert.equal([...state.matchAll(/id: "preview-[0-5]"/g)].length, 7);
  assert.doesNotMatch(state, /relay-token|wss:\/\//);
  assert.match(commands, /static let openAppWhenRun = true/);
  assert.match(appEntitlements, /\$\(CODEX_DECK_APP_GROUP\)/);
  assert.match(widgetEntitlements, /\$\(CODEX_DECK_APP_GROUP\)/);
});

test("iPhone can follow one agent with a private Live Activity and exact deep link", async () => {
  const [plist, shared, service, store, detail, live, bundle, app] = await Promise.all([
    readFile(new URL("../ios/Configuration/Info.plist", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckShared/CodexAgentActivity.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Background/AgentLiveActivityService.swift", import.meta.url),
      "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/AgentDetailView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckWidgets/CodexAgentLiveActivity.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckWidgets/CodexDeckWidgets.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/CodexDeckMobileApp.swift", import.meta.url), "utf8")
  ]);
  assert.match(plist, /NSSupportsLiveActivities/);
  assert.match(shared, /ActivityAttributes/);
  assert.doesNotMatch(shared, /token|wss:\/\//);
  assert.match(service, /ActivityAuthorizationInfo\(\)\.areActivitiesEnabled/);
  assert.match(service, /staleDate/);
  assert.match(store, /followed-agent/);
  assert.match(store, /\.seconds\(60\)/);
  assert.match(detail, /Follow on Lock Screen/);
  assert.match(live, /ActivityConfiguration\(for: CodexAgentActivityAttributes\.self\)/);
  assert.match(live, /DynamicIsland/);
  assert.match(bundle, /CodexAgentLiveActivity\(\)/);
  assert.match(app, /\.onOpenURL \{ store\.handleURL\(\$0\) \}/);
});

test("iPhone app layouts preserve native agent modes and import Stream Deck keys one way", async () => {
  const [layouts, store, device, settings, detail] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Models/MobileLayouts.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/MicroDeviceView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/SettingsView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/AgentDetailView.swift", import.meta.url), "utf8")
  ]);
  assert.match(layouts, /case automatic[\s\S]*case coding[\s\S]*case review[\s\S]*case mobile/);
  assert.doesNotMatch(store, /favorite-agents|toggleFavorite/);
  assert.match(store, /codexAgentModeTitle/);
  assert.match(store, /mobile-layout-key-assignments-v1/);
  assert.match(store, /func importSelectedComputerLayout\(\)/);
  assert.doesNotMatch(device, /star\.slash/);
  assert.match(settings, /Import keys from selected computer/);
  assert.match(settings, /Agent mode/);
  assert.match(settings, /It does not change the Stream Deck or Codex/);
  assert.doesNotMatch(detail, /Favorites|favorite/);
});

test("iPhone host diagnostics are sanitized and use a non-mutating WebSocket probe", async () => {
  const [models, connection, store, settings] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Models/RelayModels.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Networking/RelayNodeConnection.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/SettingsView.swift", import.meta.url), "utf8")
  ]);
  assert.match(models, /lastRoundTripMilliseconds/);
  assert.match(models, /capabilities: \[String\]/);
  assert.match(connection, /sendPing/);
  assert.match(store, /sanitizedDiagnostics/);
  assert.doesNotMatch(store, /sanitizedDiagnostics[\s\S]{0,2000}tokenKey/);
  assert.match(settings, /Test connection/);
  assert.match(settings, /Share sanitized diagnostics/);
  assert.match(settings, /Re-pair required/);
});

test("iPhone schedules a bounded background refresh for shared widget snapshots", async () => {
  const [plist, app, refresh, store, connection] = await Promise.all([
    readFile(new URL("../ios/Configuration/Info.plist", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/CodexDeckMobileApp.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Background/WidgetBackgroundRefresh.swift", import.meta.url),
      "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Networking/RelayNodeConnection.swift", import.meta.url),
      "utf8")
  ]);
  assert.match(plist, /BGTaskSchedulerPermittedIdentifiers/);
  assert.match(plist, /\$\(CODEX_DECK_BUNDLE_ID\)\.widget-refresh/);
  assert.match(plist, /UIBackgroundModes[\s\S]*<string>fetch<\/string>/);
  assert.match(app, /WidgetBackgroundRefresh\.register\(\)/);
  assert.match(app, /case \.background:[\s\S]*WidgetBackgroundRefresh\.schedule\(\)/);
  assert.match(refresh, /BGAppRefreshTaskRequest/);
  assert.match(refresh, /earliestBeginDate/);
  assert.match(store, /func refreshWidgetSnapshots\(\) async -> Bool/);
  assert.match(store, /\.seconds\(20\)/);
  assert.match(connection, /stop\(publishOffline: Bool = true\)/);
});

test("iPhone signing is portable and keeps personal identifiers out of source", async () => {
  const [project, config, ignore, script, appPlist, widgetPlist] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile.xcodeproj/project.pbxproj", import.meta.url), "utf8"),
    readFile(new URL("../ios/Configuration/Base.xcconfig", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../scripts/configure-ios-signing.sh", import.meta.url), "utf8"),
    readFile(new URL("../ios/Configuration/Info.plist", import.meta.url), "utf8"),
    readFile(new URL("../ios/Configuration/WidgetInfo.plist", import.meta.url), "utf8")
  ]);
  assert.match(project, /Base\.xcconfig/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = "\$\(CODEX_DECK_BUNDLE_ID\)"/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = "\$\(CODEX_DECK_WIDGET_BUNDLE_ID\)"/);
  assert.doesNotMatch(project, /DEVELOPMENT_TEAM = [A-Z0-9]+/);
  assert.match(config, /CODEX_DECK_BUNDLE_ID = com\.example\.CodexDeckMobile/);
  assert.doesNotMatch(project, /DEVELOPMENT_TEAM = [A-Z0-9]+/);
  assert.match(config, /#include\? "Local\.xcconfig"/);
  assert.match(ignore, /ios\/Configuration\/Local\.xcconfig/);
  assert.match(script, /ios\/Configuration\/Local\.xcconfig/);
  assert.match(script, /CODEX_DECK_APP_GROUP/);
  assert.match(appPlist, /<key>CodexDeckAppGroup<\/key>\s*<string>\$\(CODEX_DECK_APP_GROUP\)<\/string>/);
  assert.match(widgetPlist, /<key>CodexDeckAppGroup<\/key>\s*<string>\$\(CODEX_DECK_APP_GROUP\)<\/string>/);
});

test("context rings are optional in both Stream Deck and the native iPhone app", async () => {
  const [manifest, inspector, plugin, render, settings, device, store] = await Promise.all([
    readFile(new URL("../static/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../static/property-inspector/agent.html", import.meta.url), "utf8"),
    readFile(new URL("../src/plugin.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render.ts", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/SettingsView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/MicroDeviceView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8")
  ]);
  assert.equal((manifest.match(/static\/property-inspector\/agent\.html/g) ?? []).length, 6);
  assert.match(inspector, /getGlobalSettings/);
  assert.match(inspector, /setGlobalSettings/);
  assert.match(inspector, /showContextRings/);
  assert.match(inspector, /focusCodexOnAgentPress/);
  assert.match(inspector, /Focus Codex\*/);
  assert.match(inspector, /available on macOS only/);
  assert.match(plugin, /onDidReceiveGlobalSettings/);
  assert.match(plugin, /setFocusCodexOnAgentPress\(event\.settings\.focusCodexOnAgentPress === true\)/);
  assert.match(render, /data-context-used/);
  assert.match(settings, /Toggle\([\s\S]*"Context rings"/);
  assert.match(device, /ContextUsageIndicator/);
  assert.match(store, /show-context-rings/);
});

test("iPhone agent keys expose animated long-press details without replacing tap activation", async () => {
  const [dashboard, device, detail, widgets, widgetState, store] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Views/DashboardView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/MicroDeviceView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/AgentDetailView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckWidgets/CodexDeckWidgets.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckShared/CodexWidgetState.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8")
  ]);
  assert.match(device, /\.onTapGesture[\s\S]*store\.activate\(agent\)/);
  assert.match(device, /\.onLongPressGesture\([\s\S]*minimumDuration: 0\.48[\s\S]*showAgent\(reference\)/);
  assert.match(device, /lastLongPressAt/);
  assert.doesNotMatch(device, /private var agentGesture/);
  assert.match(device, /CodexTheme\.selection\.opacity\(0\.88\)/);
  assert.match(store, /activatingAgents/);
  assert.match(store, /Opened on/);
  assert.match(dashboard, /\.sheet\(item: \$store\.presentedAgentReference\)/);
  assert.match(detail, /Agent details/);
  assert.match(detail, /ContextDetailCard/);
  assert.match(detail, /Open on/);
  assert.match(widgets, /WidgetAgentStatusOrb/);
  assert.match(widgetState, /contextUsedPercent/);
  assert.match(widgetState, /displayEquivalent/);
  assert.match(widgetState, /timeIntervalSince\(previous\.updatedAt\) < 30/);
});

test("empty iPhone agent keys render one centered plus", async () => {
  const source = await readFile(
    new URL("../ios/CodexDeckMobile/Views/MicroDeviceView.swift", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("private struct MicroAgentKey"),
    source.indexOf("private struct ConfigurableDeviceKey"));
  assert.doesNotMatch(body, /plus\.circle\.fill/);
  assert.equal(body.match(/Image\(systemName: "plus"\)/g)?.length, 1);
  assert.match(body, /if let agent[\s\S]*else \{[\s\S]*Image\(systemName: "plus"\)/);
});

test("iPhone header keeps the Codex Micro wordmark on one line", async () => {
  const dashboard = await readFile(
    new URL("../ios/CodexDeckMobile/Views/DashboardView.swift", import.meta.url), "utf8");
  const header = dashboard.slice(dashboard.indexOf("private struct HeaderView"), dashboard.indexOf("private struct HeaderGlassActions"));
  assert.match(header, /Text\("CODEX"\)[\s\S]*?\.lineLimit\(1\)/);
  assert.match(header, /Text\("MICRO"\)[\s\S]*?\.lineLimit\(1\)/);
  assert.match(header, /\.fixedSize\(horizontal: true, vertical: false\)/);
});

test("iPhone landscape uses a bounded two-column dashboard", async () => {
  const dashboard = await readFile(
    new URL("../ios/CodexDeckMobile/Views/DashboardView.swift", import.meta.url), "utf8");
  assert.match(dashboard, /@Environment\(\\\.verticalSizeClass\)/);
  assert.match(dashboard, /compactHeight: verticalSizeClass == \.compact/);
  assert.match(dashboard, /ViewThatFits\(in: \.horizontal\)/);
  assert.match(dashboard, /HStack\(alignment: \.top, spacing: 18\)/);
  assert.match(dashboard, /microDevice[\s\S]*?\.frame\(width: 325\)/);
  assert.match(dashboard, /\.frame\(width: 315\)/);
  assert.match(dashboard, /microDevice[\s\S]*?\.frame\(maxWidth: 360\)/);
  const device = await readFile(
    new URL("../ios/CodexDeckMobile/Views/MicroDeviceView.swift", import.meta.url), "utf8");
  assert.match(device, /padding\(\.horizontal, verticalSizeClass == \.compact \? 33 : 43\)/);
  assert.match(device, /padding\(\.vertical, verticalSizeClass == \.compact \? 30 : 38\)/);
  assert.match(device, /DeviceScrews\(\)\.padding\(verticalSizeClass == \.compact \? 18 : 17\)/);
  assert.match(device, /size: verticalSizeClass == \.compact \? 10 : 15/);
  assert.match(device, /width: verticalSizeClass == \.compact \? 4\.5 : 7/);
  assert.match(device, /scaleEffect\(verticalSizeClass == \.compact \? 0\.97 : 1\)/);
});

test("iPhone app icon supplies opaque light, dark, and tinted 1024px appearances", async () => {
  const iconRoot = new URL(
    "../ios/CodexDeckMobile/Assets.xcassets/AppIcon.appiconset/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("Contents.json", iconRoot), "utf8")) as {
    images: Array<{ filename?: string; appearances?: Array<{ value?: string }> }>;
  };
  const files = new Map(manifest.images.map((entry) => [
    entry.appearances?.[0]?.value ?? "light", entry.filename
  ]));
  assert.deepEqual([...files.keys()], ["light", "dark", "tinted"]);
  for (const filename of files.values()) {
    assert.ok(filename);
    const png = await readFile(new URL(filename!, iconRoot));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    assert.equal(png[25], 2, `${filename} must be opaque RGB without alpha`);
  }
});

test("iPhone attention center baselines snapshots, persists events, and keeps alerts optional", async () => {
  const [models, store, center, settings, notifications, app, dashboard] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Models/AttentionEvents.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/AttentionCenterView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/SettingsView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Notifications/AttentionNotificationService.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/CodexDeckMobileApp.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/DashboardView.swift", import.meta.url), "utf8")
  ]);
  assert.match(models, /enum AttentionEventKind[\s\S]*case approval[\s\S]*case completion[\s\S]*case error/);
  assert.match(models, /enum AttentionFilter[\s\S]*case mac[\s\S]*case windows/);
  assert.match(store, /firstLiveSnapshot[\s\S]*processAttentionEvents\(suppressEvents: firstLiveSnapshot\)/);
  assert.match(store, /attention-events/);
  assert.match(center, /Mark all read/);
  assert.match(center, /AgentDetailView\(reference: reference\)/);
  assert.match(settings, /Attention notifications/);
  assert.match(notifications, /UNUserNotificationCenter/);
  assert.match(app, /codexAttentionOpened/);
  assert.match(dashboard, /unreadAttentionCount/);
});

test("iPhone commands use stable thread transactions with optional receipts", async () => {
  const [models, connection, store, settings, dashboard, detail] = await Promise.all([
    readFile(new URL("../ios/CodexDeckMobile/Models/RelayModels.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Networking/RelayNodeConnection.swift", import.meta.url),
      "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/SettingsView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/DashboardView.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/AgentDetailView.swift", import.meta.url), "utf8")
  ]);
  assert.match(models, /enum ThreadIdentity/);
  assert.match(models, /enum CommandFeedbackMode:[\s\S]*case minimal[\s\S]*case detailed[\s\S]*case off/);
  assert.match(connection, /struct RelayDelivery|-> RelayDelivery/);
  assert.match(store, /func agent\(withIdentity identity: String\)/);
  assert.match(store, /waitForAgentOpen/);
  assert.match(store, /command-feedback-mode/);
  assert.match(store, /always-show-critical-errors/);
  assert.match(settings, /"Command feedback"/);
  assert.match(settings, /"Always show critical errors"/);
  assert.match(dashboard, /CommandReceiptHUD/);
  assert.match(detail, /store\.agent\(for: reference\)/);
});

test("nearby iPhone pairing uses Bonjour discovery, QR deep links, and certificate pinning", async () => {
  const [plist, discovery, app, connection, store, settings, windows, mac] = await Promise.all([
    readFile(new URL("../ios/Configuration/Info.plist", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Networking/LocalNodeDiscovery.swift", import.meta.url),
      "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/CodexDeckMobileApp.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../ios/CodexDeckMobile/Networking/RelayNodeConnection.swift", import.meta.url),
      "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Store/DashboardStore.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/CodexDeckMobile/Views/SettingsView.swift", import.meta.url), "utf8"),
    readFile(new URL("../launcher/Configure-CodexDeckMobile.ps1", import.meta.url), "utf8"),
    readFile(new URL("../launcher/macos/codex-deck-macos.ts", import.meta.url), "utf8")
  ]);
  assert.match(plist, /NSBonjourServices[\s\S]*_codexdeck\._tcp/);
  assert.match(plist, /NSAllowsLocalNetworking/);
  assert.match(plist, /CFBundleURLSchemes[\s\S]*codexdeck/);
  assert.match(discovery, /\.bonjourWithTXTRecord\(type: "_codexdeck\._tcp"/);
  assert.match(discovery, /isPrivateIPv4/);
  assert.match(app, /\.onOpenURL \{ store\.handleURL\(\$0\) \}/);
  assert.match(store, /func handleURL\(_ url: URL\)[\s\S]*handlePairingURL\(url\)/);
  assert.match(connection, /PinnedCertificateDelegate/);
  assert.match(connection, /SHA256\.hash/);
  assert.match(store, /pairedHostId/);
  assert.match(settings, /Nearby/);
  assert.match(settings, /Remote via Tailscale/);
  assert.match(windows, /\[switch\]\$Local/);
  assert.match(mac, /mobile-local-config/);
});
