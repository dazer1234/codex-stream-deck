import XCTest

@testable import CodexDeckMobile

final class MobileMergeTests: XCTestCase {
  func testReasoningCommandEncodesExplicitUnrestrictedUltraPolicy() throws {
    let data = try JSONEncoder().encode(RelayCommand.reasoning(direction: "increase"))
    let payload = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any])

    XCTAssertEqual(payload["kind"] as? String, "reasoning")
    XCTAssertEqual(payload["direction"] as? String, "increase")
    XCTAssertEqual(payload["includeUltra"] as? Bool, true)
    XCTAssertEqual(Set(payload.keys), Set(["kind", "direction", "includeUltra"]))
  }

  func testDeduplicatesMirroredThreadAndRoutesToRolloutOwner() throws {
    let windows = host("win", .win32)
    let mac = host("mac", .darwin)
    let thread = "thread:11111111-1111-4111-8111-111111111111"
    let inputs = [
      snapshot(
        host: windows, slot: slot(thread: thread, title: "Build iOS", status: "idle", owned: false),
        sessions: []),
      snapshot(
        host: mac, slot: slot(thread: thread, title: "Build iOS", status: "working", owned: true),
        sessions: [
          HostSessionPresence(
            threadId: thread, activityAt: 2_000, status: "working", completionRevision: nil)
        ]),
    ]

    let result = MobileMerge.agents(from: inputs)
    XCTAssertEqual(result.count, 1)
    XCTAssertEqual(result[0].host.hostId, mac.hostId)
    XCTAssertEqual(result[0].status, "working")
    XCTAssertEqual(result[0].sourceSlot, 0)
  }

  func testStaleMirrorCannotKeepFreshOwnerWorkingOrSelected() throws {
    let windows = host("win", .win32)
    let mac = host("mac", .darwin)
    let thread = "thread:11111111-1111-4111-8111-111111111111"
    let staleMirror = AgentSlot(
      id: 0, threadKey: thread, title: "Build iOS", status: "working", selected: true,
      activityAt: 1_000, ownedByHost: false)
    let result = MobileMerge.agents(from: [
      snapshot(host: windows, slot: staleMirror, sessions: [], observedAt: 1_000),
      snapshot(
        host: mac,
        slot: slot(thread: thread, title: "Build iOS", status: "idle", owned: true),
        sessions: [], observedAt: 7_001),
    ])
    let agent = try XCTUnwrap(result.first)
    XCTAssertEqual(agent.host.platform, .darwin)
    XCTAssertEqual(agent.status, "idle")
    XCTAssertFalse(agent.selected)
  }

  func testHistoricalSessionCompletionCannotResurrectAnIdleNativeSlot() throws {
    let mac = host("mac", .darwin)
    let thread = "local:11111111-1111-4111-8111-111111111111"
    let result = MobileMerge.agents(from: [
      snapshot(
        host: mac,
        slot: slot(thread: thread, title: "Test task", status: "idle"),
        sessions: [
          HostSessionPresence(
            threadId: thread, activityAt: 1_000, status: "complete",
            completionRevision: 10)
        ], observedAt: 1_000 + 5 * 60_000 + 1)
    ])

    XCTAssertEqual(try XCTUnwrap(result.first).status, "idle")
  }

  func testAcknowledgedSessionCompletionStaysIdleUntilItsRevisionChanges() throws {
    let mac = host("mac", .darwin)
    let thread = "local:22222222-2222-4222-8222-222222222222"
    let input = snapshot(
      host: mac,
      slot: slot(thread: thread, title: "Fresh completion", status: "idle"),
      sessions: [
        HostSessionPresence(
          threadId: thread, activityAt: 2_000, status: "complete", completionRevision: 20)
      ], observedAt: 2_001)
    let key = MobileMerge.completionKey(
      hostID: mac.hostId, identity: ThreadIdentity.canonical(thread))

    XCTAssertEqual(MobileMerge.agents(from: [input]).first?.status, "complete")
    XCTAssertEqual(
      MobileMerge.agents(from: [input], acknowledgedCompletions: [key: 20]).first?.status,
      "idle")
  }

  func testRemoteMirrorUsesWindowsBadgeButRoutesThroughConnectedMac() {
    let mac = host("mac", .darwin)
    let remote = slot(
      thread: "44444444-4444-4444-8444-444444444444", title: "Windows task",
      status: "idle", owned: false)

    let result = MobileMerge.agents(from: [snapshot(host: mac, slot: remote, sessions: [])])

    XCTAssertEqual(result.first?.originPlatform, .win32)
    XCTAssertEqual(result.first?.host.platform, .darwin)
  }

  func testTemporaryWindowsNewThreadMergesWithSessionBackedMacMirror() throws {
    let windows = host("win", .win32)
    let mac = host("mac", .darwin)
    let temporary = "local:client-new-thread:819699e8-ed6d-46fb-bfd1-3280c028de2b"
    let rollout = "019f804a-4e0a-7b32-bf66-af64a405d2d5"
    let title = "Autocheck 3 Installation prüfen"
    let windowsSlot = AgentSlot(
      id: 0, threadKey: temporary, title: title, status: "idle", selected: true,
      activityAt: 2_000, ownedByHost: false)
    let macSlot = AgentSlot(
      id: 0, threadKey: "local:\(rollout)", title: title, status: "working", selected: false,
      activityAt: 2_000, ownedByHost: false)
    let inputs = [
      snapshot(
        host: windows, slot: windowsSlot,
        sessions: [
          HostSessionPresence(
            threadId: rollout, activityAt: 2_000, status: "complete", completionRevision: 10)
        ], activeThreadKey: temporary),
      snapshot(host: mac, slot: macSlot, sessions: []),
    ]

    let matches = MobileMerge.agents(from: inputs).filter { $0.title == title }
    let result = try XCTUnwrap(matches.first)
    XCTAssertEqual(matches.count, 1)
    XCTAssertEqual(result.host.platform, .win32)
    XCTAssertEqual(result.originPlatform, .win32)
    XCTAssertEqual(result.sourceSlot, 0)
    XCTAssertEqual(result.threadKey, temporary)
    XCTAssertTrue(result.selected)
    XCTAssertEqual(result.status, "working")
  }

  func testAttentionSortsAheadOfWorkingAndIdle() {
    let windows = host("win", .win32)
    let mac = host("mac", .darwin)
    let inputs = [
      snapshot(
        host: windows,
        slots: [
          slot(
            id: 0, thread: "11111111-1111-4111-8111-111111111111", title: "Idle", status: "idle"),
          slot(
            id: 1, thread: "22222222-2222-4222-8222-222222222222", title: "Work", status: "working"),
          slot(
            id: 2, thread: "33333333-3333-4333-8333-333333333333", title: "Approve",
            status: "awaiting-approval"),
        ]),
      snapshot(host: mac),
    ]
    XCTAssertEqual(MobileMerge.agents(from: inputs).map(\.title), ["Approve", "Work", "Idle"])
  }

  func testNewestUsageSnapshotWinsAcrossHosts() {
    let older = snapshot(host: host("win", .win32), usageObservedAt: 1_000)
    let newer = snapshot(host: host("mac", .darwin), usageObservedAt: 2_000)
    XCTAssertEqual(MobileMerge.accountUsage(from: [older, newer])?.host.platform, .darwin)
  }

  func testAccountUsageWorksWithMacOnly() {
    let mac = snapshot(host: host("mac", .darwin), usageObservedAt: 3_000)
    let result = MobileMerge.accountUsage(from: [mac])
    XCTAssertEqual(result?.host.platform, .darwin)
    XCTAssertEqual(result?.snapshot.usage?.resetCreditsAvailable, 1)
  }

  func testSnapshotReceiptNormalizationRemovesHostClockSkew() throws {
    let mac = host("mac", .darwin)
    let thread = "11111111-1111-4111-8111-111111111111"
    let input = HostSnapshot(
      host: mac,
      observedAt: 1_000_000,
      snapshot: MicroSnapshot(
        slots: (0..<6).map { index in
          AgentSlot(
            id: index,
            threadKey: index == 0 ? thread : nil,
            title: index == 0 ? "Clock skew" : nil,
            status: index == 0 ? "working" : "off",
            selected: index == 0,
            activityAt: index == 0 ? 990_000 : nil,
            ownedByHost: index == 0 ? true : nil)
        },
        activeThreadKey: thread,
        activeThreadTitle: "Clock skew",
        layout: MicroLayout(version: 1, slots: [:]),
        agentSource: "recent",
        lightingAutoOff: "never",
        theme: "light",
        usage: UsageSnapshot(
          windows: [
            UsageWindow(
              id: "weekly", kind: "weekly", usedPercent: 40, remainingPercent: 60,
              windowDurationMins: 10_080, resetsAt: 1_600_000)
          ],
          observedAt: 1_000_000,
          resetCreditsAvailable: 1,
          resetCreditsApplicable: 1),
        hostSessions: [
          HostSessionPresence(
            threadId: thread, activityAt: 970_000, status: "working",
            completionRevision: nil)
        ]))

    let normalized = input.normalizedToReceiptTime(1_030_000)
    XCTAssertEqual(normalized.observedAt, 1_030_000)
    XCTAssertEqual(normalized.snapshot.slots[0].activityAt, 1_020_000)
    XCTAssertEqual(normalized.snapshot.hostSessions?[0].activityAt, 1_000_000)
    XCTAssertEqual(normalized.snapshot.usage?.observedAt, 1_030_000)
    XCTAssertEqual(normalized.snapshot.usage?.windows[0].resetsAt, 1_630_000)
  }

  func testContextUsageFollowsTheBackingHostAcrossMirrors() {
    let windows = host("win", .win32)
    let mac = host("mac", .darwin)
    let thread = "thread:11111111-1111-4111-8111-111111111111"
    let result = MobileMerge.agents(from: [
      snapshot(
        host: windows,
        slot: AgentSlot(
          id: 0, threadKey: thread, title: "Mirror", status: "idle", selected: false,
          activityAt: 1_000, ownedByHost: false, contextUsedPercent: nil),
        sessions: []),
      snapshot(
        host: mac,
        slot: AgentSlot(
          id: 0, threadKey: thread, title: "Owner", status: "working", selected: false,
          activityAt: 2_000, ownedByHost: true, contextUsedPercent: 61),
        sessions: [
          HostSessionPresence(
            threadId: thread, activityAt: 2_000, status: "working", completionRevision: nil,
            contextUsedPercent: 61)
        ]),
    ])
    XCTAssertEqual(result.first?.host.platform, .darwin)
    XCTAssertEqual(result.first?.contextUsedPercent, 61)
  }

  @MainActor
  func testContextRingPreferenceDefaultsOnAndPersistsOff() {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    var store = DashboardStore(defaults: defaults)
    XCTAssertTrue(store.showContextRings)
    store.setShowContextRings(false)
    store = DashboardStore(defaults: defaults)
    XCTAssertFalse(store.showContextRings)
  }

  @MainActor
  func testCommandFeedbackPreferencesDefaultToMinimalAndPersist() {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    var store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.commandFeedbackMode, .minimal)
    XCTAssertTrue(store.alwaysShowCriticalErrors)

    store.setCommandFeedbackMode(.detailed)
    store.setAlwaysShowCriticalErrors(false)
    store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.commandFeedbackMode, .detailed)
    XCTAssertFalse(store.alwaysShowCriticalErrors)
  }

  @MainActor
  func testAttentionCenterTreatsFirstSnapshotAsBaselineAndEmitsOnlyOnTransition() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Mac", url: URL(string: "wss://mac.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }

    var connection: MockRelayConnection?
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let created = MockRelayConnection(profileID: profile.id, update: update)
      connection = created
      return created
    }
    await store.start()
    let mac = host("mac", .darwin)
    let thread = "thread:11111111-1111-4111-8111-111111111111"

    connection?.publish(
      snapshot(
        host: mac,
        slot: slot(thread: thread, title: "Existing approval", status: "awaiting-approval"),
        sessions: []))
    XCTAssertTrue(store.attentionEvents.isEmpty, "Initial state must not create a notification flood")

    connection?.publish(
      snapshot(
        host: mac, slot: slot(thread: thread, title: "Continue work", status: "working"),
        sessions: []))
    XCTAssertTrue(store.attentionEvents.isEmpty)

    connection?.publish(
      snapshot(
        host: mac,
        slot: slot(thread: thread, title: "Continue work", status: "awaiting-response"),
        sessions: []))
    XCTAssertEqual(store.attentionEvents.count, 1)
    XCTAssertEqual(store.attentionEvents.first?.kind, .response)

    connection?.publish(
      snapshot(
        host: mac,
        slot: slot(thread: thread, title: "Continue work", status: "awaiting-response"),
        sessions: []))
    XCTAssertEqual(store.attentionEvents.count, 1, "An unchanged snapshot must not duplicate events")
  }

  @MainActor
  func testAttentionCompletionRevisionCanCreateANewEventWithoutAStatusChange() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Windows", url: URL(string: "wss://windows.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }

    var connection: MockRelayConnection?
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let created = MockRelayConnection(profileID: profile.id, update: update)
      connection = created
      return created
    }
    await store.start()
    let windows = host("win", .win32)
    let thread = "thread:22222222-2222-4222-8222-222222222222"
    let completedSlot = slot(thread: thread, title: "Release build", status: "completed")

    connection?.publish(
      snapshot(
        host: windows, slot: completedSlot,
        sessions: [
          HostSessionPresence(
            threadId: thread, activityAt: 1_000, status: "completed", completionRevision: 1)
        ]))
    XCTAssertTrue(store.attentionEvents.isEmpty)

    connection?.publish(
      snapshot(
        host: windows, slot: completedSlot,
        sessions: [
          HostSessionPresence(
            threadId: thread, activityAt: 2_000, status: "completed", completionRevision: 2)
        ]))
    XCTAssertEqual(store.attentionEvents.count, 1)
    XCTAssertEqual(store.attentionEvents.first?.kind, .completion)
  }

  @MainActor
  func testAttentionReadStateAndHistoryPersist() {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let event = AttentionEvent(
      id: UUID(), kind: .error,
      threadIdentity: "33333333-3333-4333-8333-333333333333", title: "Broken build",
      hostID: "mac", hostName: "Mac", platform: .darwin, occurredAt: .now, isRead: false)
    defaults.set(try? JSONEncoder().encode([event]), forKey: "attention-events")

    var store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.unreadAttentionCount, 1)
    store.markAttentionRead(event.id)
    XCTAssertEqual(store.unreadAttentionCount, 0)

    store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.attentionEvents.first?.id, event.id)
    XCTAssertTrue(store.attentionEvents.first?.isRead == true)
    store.clearAttentionEvents()
    XCTAssertTrue(store.attentionEvents.isEmpty)
  }

  func testCanonicalThreadIdentitySurvivesRelayPrefixes() {
    let id = "11111111-1111-4111-8111-111111111111"
    XCTAssertEqual(ThreadIdentity.canonical(id), id)
    XCTAssertEqual(ThreadIdentity.canonical("local:thread:\(id.uppercased())"), id)
  }

  @MainActor
  func testLiveActivityDeepLinkPresentsTheCanonicalAgentReference() throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let identity = "11111111-1111-4111-8111-111111111111"
    let url = try XCTUnwrap(
      CodexAgentActivityLink.url(
        threadIdentity: identity,
        fallbackTitle: "Polish iPhone UI",
        fallbackPlatform: HostPlatform.win32.rawValue))

    let store = DashboardStore(defaults: defaults)
    store.showingAttentionCenter = true
    store.showingSettings = true
    store.handleURL(url)

    XCTAssertEqual(store.presentedAgentReference?.threadIdentity, identity)
    XCTAssertEqual(store.presentedAgentReference?.fallbackTitle, "Polish iPhone UI")
    XCTAssertEqual(store.presentedAgentReference?.fallbackPlatform, .win32)
    XCTAssertFalse(store.showingAttentionCenter)
    XCTAssertFalse(store.showingSettings)
    XCTAssertFalse(url.absoluteString.contains("token"))
    XCTAssertFalse(url.absoluteString.contains("wss://"))
  }

  func testFollowedAgentReferenceRoundTripsForRelaunchRecovery() throws {
    let reference = AgentReference(
      threadIdentity: "local:thread:22222222-2222-4222-8222-222222222222",
      fallbackTitle: "Keep following",
      fallbackPlatform: .darwin)
    let decoded = try JSONDecoder().decode(
      AgentReference.self, from: JSONEncoder().encode(reference))
    XCTAssertEqual(decoded.threadIdentity, "22222222-2222-4222-8222-222222222222")
    XCTAssertEqual(decoded, reference)
  }

  @MainActor
  func testAgentActivationReResolvesAThreadAfterItMovesSlots() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Windows", url: URL(string: "wss://windows.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }

    var connection: MockRelayConnection?
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let created = MockRelayConnection(profileID: profile.id, update: update)
      connection = created
      return created
    }
    await store.start()
    let host = host("win", .win32)
    let thread = "thread:11111111-1111-4111-8111-111111111111"
    connection?.publish(
      snapshot(
        host: host,
        slot: slot(id: 0, thread: thread, title: "Moving task", status: "idle"),
        sessions: []))
    let staleButtonValue = try XCTUnwrap(store.agents.first)

    let moved = slot(id: 4, thread: thread, title: "Moving task", status: "idle")
    connection?.publish(snapshot(host: host, slots: [moved]))
    connection?.onSend = { [weak connection] command in
      guard case .agent(_, _, let act) = command, act == 0 else { return }
      connection?.publish(
        self.snapshot(
          host: host,
          slots: [
            AgentSlot(
              id: 4, threadKey: thread, title: "Moving task", status: "idle", selected: true,
              activityAt: 2_000, ownedByHost: true)
          ],
          activeThreadKey: thread))
    }

    await store.activate(staleButtonValue)

    XCTAssertEqual(connection?.commands.count, 2)
    guard let first = connection?.commands.first,
      case .agent(let slot, let sentThread, let act) = first
    else { return XCTFail("Expected an agent press") }
    XCTAssertEqual(slot, 4)
    XCTAssertEqual(sentThread, thread)
    XCTAssertEqual(act, 1)
    XCTAssertEqual(store.commandReceipt?.stage, .stateConfirmed)
  }

  @MainActor
  func testAgentActivationRejectsAStaleSnapshotBeforeSending() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Mac", url: URL(string: "wss://mac.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }

    var connection: MockRelayConnection?
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let created = MockRelayConnection(profileID: profile.id, update: update)
      connection = created
      return created
    }
    await store.start()
    let input = snapshot(
      host: host("mac", .darwin),
      slot: slot(
        thread: "11111111-1111-4111-8111-111111111111", title: "Stale task",
        status: "idle"),
      sessions: [])
    connection?.publish(input, receivedAt: Date(timeIntervalSinceNow: -30))
    let agent = try XCTUnwrap(store.agents.first)

    await store.activate(agent)

    XCTAssertTrue(connection?.commands.isEmpty == true)
    XCTAssertEqual(store.commandReceipt?.stage, .failed)
    XCTAssertTrue(store.commandReceipt?.detail.contains("old snapshot") == true)
  }

  @MainActor
  func testRemovingComputerClearsProfileTokenAndCachedSnapshot() throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Mac", url: URL(string: "wss://mac.example.ts.net:47651")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    defaults.set(Data("cached".utf8), forKey: "snapshot-\(profile.id.uuidString)")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)

    let store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.profiles, [profile])
    store.removeProfile(profile)

    XCTAssertTrue(store.profiles.isEmpty)
    XCTAssertNil(defaults.data(forKey: "snapshot-\(profile.id.uuidString)"))
    XCTAssertNil(try KeychainStore.value(for: profile.tokenKey))
  }

  @MainActor
  func testInterchangeableDeviceKeysPersistAndResetToNativeLayout() throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    var store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.keycapID(for: .action1), "FAST")
    XCTAssertEqual(store.keycapID(for: .corner), "CODEX")
    XCTAssertFalse(store.isKeycapCustomized(.action1))

    store.assignKeycap("TERM", to: .action1)
    XCTAssertEqual(store.keycapID(for: .action1), "TERM")
    XCTAssertTrue(store.isKeycapCustomized(.action1))

    store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.keycapID(for: .action1), "TERM")
    store.assignKeycap("NOT-A-REAL-KEY", to: .action1)
    XCTAssertEqual(store.keycapID(for: .action1), "TERM")

    store.resetKeycap(.action1)
    XCTAssertEqual(store.keycapID(for: .action1), "FAST")
    XCTAssertFalse(store.isKeycapCustomized(.action1))
  }

  @MainActor
  func testAppProfilesNeverInventFixedAgentSlots() {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    var store = DashboardStore(defaults: defaults)
    store.selectMobileLayout(.coding)
    XCTAssertTrue(store.mobileAgentPlacements.allSatisfy { $0.agent == nil && $0.reference == nil })

    store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.mobileLayoutProfile, .coding)
    XCTAssertTrue(store.mobileAgentPlacements.allSatisfy { $0.agent == nil && $0.reference == nil })
  }

  @MainActor
  func testLayoutProfilesKeepIndependentLowerKeyAssignments() {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = DashboardStore(defaults: defaults)

    store.selectMobileLayout(.review)
    XCTAssertEqual(store.keycapID(for: .action1), "DIFF")
    store.assignKeycap("TERM", to: .action1)
    XCTAssertEqual(store.keycapID(for: .action1), "TERM")

    store.selectMobileLayout(.mobile)
    XCTAssertEqual(store.keycapID(for: .action1), "FAST")
    XCTAssertEqual(store.keycapID(for: .action4), "NEW")

    store.selectMobileLayout(.review)
    XCTAssertEqual(store.keycapID(for: .action1), "TERM")
    store.resetKeycap(.action1)
    XCTAssertEqual(store.keycapID(for: .action1), "DIFF")
  }

  @MainActor
  func testOneWayLayoutImportCopiesOnlyValidatedKeysIntoTheCurrentAppProfile() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Mac", url: URL(string: "wss://mac.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }

    var connection: MockRelayConnection?
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let created = MockRelayConnection(profileID: profile.id, update: update)
      connection = created
      return created
    }
    await store.start()
    let importedIDs = ["TERM", "APPR", "REJ", "NEW", "MIC", "CODEX"]
    let layout = MicroLayout(
      version: 1,
      slots: Dictionary(
        uniqueKeysWithValues: zip(DeviceKeySlot.allCases, importedIDs).map { slot, id in
          (slot.nativeActionSlot, MicroLayout.Slot(keycapId: id, commandId: nil))
        }))
    connection?.publish(snapshot(host: host("mac", .darwin), layout: layout))

    store.selectMobileLayout(.coding)
    XCTAssertEqual(store.importSelectedComputerLayout(), 6)
    XCTAssertEqual(DeviceKeySlot.allCases.map(store.keycapID), importedIDs)
    store.selectMobileLayout(.review)
    XCTAssertEqual(store.keycapID(for: .action1), "DIFF")
  }

  func testEveryDeviceSlotHasTheExpectedNativeActionAndDefaultKeycap() {
    XCTAssertEqual(DeviceKeySlot.allCases.map(\.nativeActionSlot), [
      "ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12",
    ])
    XCTAssertEqual(DeviceKeySlot.allCases.map(\.defaultKeycapID), [
      "FAST", "APPR", "REJ", "SPLIT", "MIC", "CODEX",
    ])
  }

  func testWidgetCommandsStayInParityWithTheNativeKeycapCatalog() {
    XCTAssertEqual(
      CodexWidgetCommand.allCases.filter { $0 != .rateLimitReset }.map(\.rawValue),
      KeycapCatalog.all.map(\.id))
    XCTAssertTrue(CodexWidgetCommand.allCases.contains(.rateLimitReset))
  }

  func testWidgetSnapshotRoundTripsWithoutRelaySecrets() throws {
    let data = try JSONEncoder().encode(CodexWidgetState.preview)
    let decoded = try JSONDecoder().decode(CodexWidgetState.self, from: data)
    XCTAssertEqual(decoded, .preview)
    XCTAssertEqual(decoded.agents.count, 6)
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("token"))
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("wss://"))
  }

  func testWidgetAgentDecodesLegacySnapshotWithoutContextUsage() throws {
    struct LegacyWidgetAgent: Encodable {
      let id = "legacy"
      let title = "Existing widget"
      let status = "idle"
      let hostName = "Mac"
      let hostLabel = "M"
      let activityAt = Date(timeIntervalSince1970: 1_000)
      let selected = false
    }

    let data = try JSONEncoder().encode(LegacyWidgetAgent())
    let decoded = try JSONDecoder().decode(CodexWidgetAgent.self, from: data)
    XCTAssertEqual(decoded.id, "legacy")
    XCTAssertNil(decoded.contextUsedPercent)
  }

  func testNearbyPairingAcceptsOnlyPrivatePinnedSecureLinks() throws {
    let fingerprint = String(repeating: "ab", count: 32)
    var components = URLComponents(string: "codexdeck://pair")!
    components.queryItems = [
      URLQueryItem(name: "version", value: "1"),
      URLQueryItem(name: "mode", value: "nearby"),
      URLQueryItem(name: "hostId", value: "11111111-1111-4111-8111-111111111111"),
      URLQueryItem(name: "name", value: "Nearby Mac"),
      URLQueryItem(name: "platform", value: "darwin"),
      URLQueryItem(name: "endpoint", value: "wss://192.168.1.30:47653"),
      URLQueryItem(name: "token", value: String(repeating: "t", count: 32)),
      URLQueryItem(name: "fingerprint", value: fingerprint),
    ]
    let payload = try NearbyPairingPayload(url: components.url!)
    XCTAssertEqual(payload.name, "Nearby Mac")
    XCTAssertEqual(payload.endpoint.host(), "192.168.1.30")
    XCTAssertEqual(payload.fingerprintSHA256, fingerprint)

    components.queryItems = components.queryItems?.map {
      $0.name == "endpoint" ? URLQueryItem(name: "endpoint", value: "wss://203.0.113.9:47653") : $0
    }
    XCTAssertThrowsError(try NearbyPairingPayload(url: components.url!))

    components.queryItems = components.queryItems?.map {
      $0.name == "endpoint" ? URLQueryItem(name: "endpoint", value: "wss://192.168.x.1.30:47653") : $0
    }
    XCTAssertThrowsError(try NearbyPairingPayload(url: components.url!))

    components.queryItems = components.queryItems?.map {
      $0.name == "endpoint" ? URLQueryItem(name: "endpoint", value: "wss://192.168.1.30:47653") : $0
    }
    components.queryItems?.append(URLQueryItem(name: "token", value: String(repeating: "x", count: 32)))
    XCTAssertThrowsError(try NearbyPairingPayload(url: components.url!))
  }

  func testLegacyRemoteProfileDecodesWithoutNearbyMetadata() throws {
    let data = Data(
      #"{"id":"11111111-1111-4111-8111-111111111111","name":"Existing","url":"wss:\/\/mac.example.ts.net"}"#.utf8)
    let profile = try JSONDecoder().decode(NodeProfile.self, from: data)
    XCTAssertEqual(profile.connectionMode, .remote)
    XCTAssertNil(profile.pairedHostId)
    XCTAssertNil(profile.certificateSHA256)
  }

  func testRelayReadyMetadataDecodesCapabilitiesAndCodexVersion() throws {
    let data = Data(
      #"{"type":"ready","protocol":1,"host":{"hostId":"11111111-1111-4111-8111-111111111111","hostName":"Mac","platform":"darwin","codexVersion":"26.715.31925"},"capabilities":["agent","usage"],"bridge":"native-codex-micro"}"#.utf8)
    let event = try JSONDecoder().decode(RelayServerEvent.self, from: data)
    guard case .ready(let host, let metadata) = event else {
      return XCTFail("Expected relay ready metadata")
    }
    XCTAssertEqual(host.codexVersion, "26.715.31925")
    XCTAssertEqual(metadata.capabilities, ["agent", "usage"])
    XCTAssertEqual(metadata.bridge, "native-codex-micro")
  }

  @MainActor
  func testSanitizedDiagnosticsAndNonMutatingConnectionProbe() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Mac", url: URL(string: "wss://mac.example.ts.net/private?secret=no")!)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    let token = "t".repeated(32)
    try KeychainStore.set(token, for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }

    var connection: MockRelayConnection?
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let created = MockRelayConnection(profileID: profile.id, update: update)
      connection = created
      return created
    }
    await store.start()
    connection?.publishStatus(
      NodeStatus(
        state: .ready,
        host: CodexHost(
          hostId: "11111111-1111-4111-8111-111111111111", hostName: "Mac",
          platform: .darwin, codexVersion: "26.715.31925"),
        detail: nil,
        relayProtocol: 1,
        capabilities: ["agent", "usage"],
        bridgeKind: "native-codex-micro"))
    let probe = try await store.testConnection(profile)
    XCTAssertEqual(probe.elapsedMilliseconds, 12)
    let report = store.sanitizedDiagnostics(for: profile)
    XCTAssertTrue(report.contains("26.715.31925"))
    XCTAssertTrue(report.contains("agent, usage"))
    XCTAssertFalse(report.contains(token))
    XCTAssertFalse(report.contains("/private"))
    XCTAssertFalse(report.contains("secret=no"))
  }

  @MainActor
  func testNearbyCertificateChangeRequiresExplicitRepair() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Nearby Mac", url: URL(string: "wss://192.168.1.20:47653")!,
      mode: .nearby, pairedHostId: "11111111-1111-4111-8111-111111111111",
      certificateSHA256: String(repeating: "a", count: 64))
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    defer { KeychainStore.remove(profile.tokenKey) }
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      MockRelayConnection(profileID: profile.id, update: update)
    }
    await store.start()
    let discovered = try XCTUnwrap(NearbyNode(txt: [
      "protocol": "1", "secure": "1", "hostId": profile.pairedHostId!,
      "hostName": "Nearby Mac", "platform": "darwin", "address": "192.168.1.20",
      "port": "47653", "fingerprint": String(repeating: "b", count: 64),
    ]))
    store.updateNearbyEndpoints([discovered])
    XCTAssertEqual(store.nodes[profile.id]?.state, .degraded)
    XCTAssertEqual(store.nodes[profile.id]?.requiresRepair, true)
    XCTAssertTrue(store.nodes[profile.id]?.detail?.contains("certificate changed") == true)
    XCTAssertEqual(store.profiles.first?.certificateSHA256, String(repeating: "a", count: 64))
  }

  @MainActor
  func testDuplicateAuthenticatedHostIsNotMergedByComputerName() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let first = NodeProfile(
      id: UUID(), name: "First name", url: URL(string: "wss://first.example.ts.net")!)
    let second = NodeProfile(
      id: UUID(), name: "Different name", url: URL(string: "wss://second.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([first, second]), forKey: "node-profiles")
    for profile in [first, second] {
      try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    }
    defer { [first, second].forEach { KeychainStore.remove($0.tokenKey) } }
    var connections: [UUID: MockRelayConnection] = [:]
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let connection = MockRelayConnection(profileID: profile.id, update: update)
      connections[profile.id] = connection
      return connection
    }
    await store.start()
    let authenticated = CodexHost(
      hostId: "11111111-1111-4111-8111-111111111111", hostName: "Authenticated",
      platform: .darwin)
    connections[first.id]?.publishStatus(NodeStatus(state: .ready, host: authenticated))
    connections[second.id]?.publishStatus(NodeStatus(state: .ready, host: authenticated))
    XCTAssertEqual(store.nodes[first.id]?.state, .ready)
    XCTAssertEqual(store.nodes[second.id]?.state, .degraded)
    XCTAssertEqual(store.nodes[second.id]?.requiresRepair, true)
    XCTAssertTrue(store.nodes[second.id]?.detail?.contains("Duplicate connection") == true)
  }

  @MainActor
  func testDuplicateProfileRoutesCommandsThroughTheHealthyConnection() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let first = NodeProfile(
      id: UUID(), name: "Keeper", url: URL(string: "wss://keeper.example.ts.net")!)
    let second = NodeProfile(
      id: UUID(), name: "Duplicate", url: URL(string: "wss://duplicate.example.ts.net")!)
    defaults.set(try JSONEncoder().encode([first, second]), forKey: "node-profiles")
    for profile in [first, second] {
      try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    }
    defer { [first, second].forEach { KeychainStore.remove($0.tokenKey) } }
    var connections: [UUID: MockRelayConnection] = [:]
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let connection = MockRelayConnection(profileID: profile.id, update: update)
      connections[profile.id] = connection
      return connection
    }
    await store.start()
    let authenticated = host("shared-host", .darwin)
    connections[second.id]?.publishStatus(NodeStatus(state: .ready, host: authenticated))
    connections[first.id]?.publishStatus(NodeStatus(state: .ready, host: authenticated))

    XCTAssertEqual(store.connectionState(for: authenticated.hostId), .ready)
    await store.pressEncoder()

    XCTAssertEqual(connections[first.id]?.commands.count, 2)
    XCTAssertTrue(connections[second.id]?.commands.isEmpty == true)
    XCTAssertEqual(store.commandReceipt?.stage, .stateConfirmed)
  }

  @MainActor
  func testOfflineSingleHostSnapshotIsVisibleButNotReportedConnected() throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let profile = NodeProfile(
      id: UUID(), name: "Offline Mac", url: URL(string: "wss://mac.example.ts.net")!)
    let mac = host("offline-mac", .darwin)
    defaults.set(try JSONEncoder().encode([profile]), forKey: "node-profiles")
    defaults.set(
      try JSONEncoder().encode(
        snapshot(
          host: mac,
          slot: slot(
            thread: "11111111-1111-4111-8111-111111111111", title: "Last known task",
            status: "working"),
          sessions: [])),
      forKey: "snapshot-\(profile.id.uuidString)")

    let store = DashboardStore(defaults: defaults)
    XCTAssertEqual(store.agents.first?.title, "Last known task")
    XCTAssertEqual(store.connectionState(for: mac.hostId), .offline)
    XCTAssertEqual(store.connectedCount, 0)
  }

  @MainActor
  func testMixedConnectionKeepsUniqueOfflineTasksWithoutOverridingLiveTasks() async throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let liveProfile = NodeProfile(
      id: UUID(), name: "Windows", url: URL(string: "wss://windows.example.ts.net")!)
    let offlineProfile = NodeProfile(
      id: UUID(), name: "Mac", url: URL(string: "wss://mac.example.ts.net")!)
    defaults.set(
      try JSONEncoder().encode([liveProfile, offlineProfile]), forKey: "node-profiles")
    for profile in [liveProfile, offlineProfile] {
      try KeychainStore.set("t".repeated(32), for: profile.tokenKey)
    }
    defer { [liveProfile, offlineProfile].forEach { KeychainStore.remove($0.tokenKey) } }
    let offlineMac = host("offline-mac", .darwin)
    defaults.set(
      try JSONEncoder().encode(
        snapshot(
          host: offlineMac,
          slot: slot(
            thread: "22222222-2222-4222-8222-222222222222", title: "Offline Mac task",
            status: "working"),
          sessions: [])),
      forKey: "snapshot-\(offlineProfile.id.uuidString)")
    var connections: [UUID: MockRelayConnection] = [:]
    let store = DashboardStore(defaults: defaults) { profile, _, update in
      let connection = MockRelayConnection(profileID: profile.id, update: update)
      connections[profile.id] = connection
      return connection
    }
    await store.start()
    connections[liveProfile.id]?.publish(
      snapshot(
        host: host("live-win", .win32),
        slot: slot(
          thread: "33333333-3333-4333-8333-333333333333", title: "Live Windows task",
          status: "idle"),
        sessions: []))

    XCTAssertEqual(Set(store.agents.map(\.title)), Set(["Live Windows task", "Offline Mac task"]))
    XCTAssertEqual(store.connectionState(for: offlineMac.hostId), .offline)
  }

  @MainActor
  func testComputerReplacementRequiresAnExplicitTargetBeforeAcceptingANewHostID() throws {
    let suiteName = "CodexDeckMobileTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let old = NodeProfile(
      id: UUID(), name: "Old Mac", url: URL(string: "wss://192.168.1.20:47653")!,
      mode: .nearby, pairedHostId: "11111111-1111-4111-8111-111111111111",
      certificateSHA256: String(repeating: "a", count: 64))
    defaults.set(try JSONEncoder().encode([old]), forKey: "node-profiles")
    try KeychainStore.set("o".repeated(32), for: old.tokenKey)
    defer { KeychainStore.remove(old.tokenKey) }
    let store = DashboardStore(defaults: defaults)
    store.beginComputerReplacement(old)

    var components = URLComponents(string: "codexdeck://pair")!
    components.queryItems = [
      URLQueryItem(name: "version", value: "1"),
      URLQueryItem(name: "mode", value: "nearby"),
      URLQueryItem(name: "hostId", value: "22222222-2222-4222-8222-222222222222"),
      URLQueryItem(name: "name", value: "Reinstalled Mac"),
      URLQueryItem(name: "platform", value: "darwin"),
      URLQueryItem(name: "endpoint", value: "wss://192.168.1.21:47653"),
      URLQueryItem(name: "token", value: "n".repeated(32)),
      URLQueryItem(name: "fingerprint", value: String(repeating: "b", count: 64)),
    ]
    store.handlePairingURL(components.url!)

    XCTAssertEqual(store.profiles.count, 1)
    XCTAssertEqual(store.profiles[0].id, old.id)
    XCTAssertEqual(store.profiles[0].pairedHostId, "22222222-2222-4222-8222-222222222222")
    XCTAssertEqual(store.profiles[0].name, "Reinstalled Mac")
    XCTAssertNil(store.replacementTargetProfileID)
    XCTAssertEqual(try KeychainStore.value(for: old.tokenKey), "n".repeated(32))
  }

  private func host(_ id: String, _ platform: HostPlatform) -> CodexHost {
    CodexHost(hostId: id, hostName: id, platform: platform)
  }

  private func slot(id: Int = 0, thread: String, title: String, status: String, owned: Bool = true)
    -> AgentSlot
  {
    AgentSlot(
      id: id, threadKey: thread, title: title, status: status, selected: false,
      activityAt: Double(1_000 + id), ownedByHost: owned)
  }

  private func snapshot(
    host: CodexHost, slot: AgentSlot, sessions: [HostSessionPresence],
    activeThreadKey: String? = nil, observedAt: Double = 1_000
  )
    -> HostSnapshot
  {
    snapshot(
      host: host, slots: [slot], sessions: sessions, activeThreadKey: activeThreadKey,
      observedAt: observedAt)
  }

  private func snapshot(
    host: CodexHost, slots: [AgentSlot] = [], sessions: [HostSessionPresence] = [],
    usageObservedAt: Double? = nil, activeThreadKey: String? = nil,
    layout: MicroLayout = MicroLayout(version: 1, slots: [:]), observedAt: Double = 1_000
  ) -> HostSnapshot {
    let empty = (0..<6).map { index in
      slots.first(where: { $0.id == index })
        ?? AgentSlot(
          id: index, threadKey: nil, title: nil, status: "off", selected: false, activityAt: nil,
          ownedByHost: nil)
    }
    let usage = usageObservedAt.map { timestamp in
      UsageSnapshot(
        windows: [], observedAt: timestamp, resetCreditsAvailable: 1, resetCreditsApplicable: 1)
    }
    return HostSnapshot(
      host: host,
      observedAt: usageObservedAt ?? observedAt,
      snapshot: MicroSnapshot(
        slots: empty,
        activeThreadKey: activeThreadKey,
        activeThreadTitle: nil,
        layout: layout,
        agentSource: "recent",
        lightingAutoOff: "never",
        theme: "light",
        usage: usage,
        hostSessions: sessions
      )
    )
  }
}

@MainActor
private final class MockRelayConnection: RelayNodeConnecting {
  let profileID: UUID
  let update: RelayNodeUpdate
  var commands: [RelayCommand] = []
  var onSend: ((RelayCommand) -> Void)?
  var probe = RelayConnectionProbe(elapsedMilliseconds: 12, measuredAt: .now)

  init(profileID: UUID, update: @escaping RelayNodeUpdate) {
    self.profileID = profileID
    self.update = update
  }

  func start() {}
  func stop(publishOffline: Bool) {}

  func send(_ command: RelayCommand) async throws -> RelayDelivery {
    commands.append(command)
    onSend?(command)
    return RelayDelivery(requestID: "request-\(commands.count)", elapsedMilliseconds: 1)
  }

  func testConnection() async throws -> RelayConnectionProbe { probe }

  func publishStatus(_ status: NodeStatus) { update(profileID, status) }

  func publish(_ snapshot: HostSnapshot, receivedAt: Date = .now) {
    update(
      profileID,
      NodeStatus(
        state: .ready, host: snapshot.host, snapshot: snapshot, detail: nil,
        changedAt: receivedAt, lastSnapshotReceivedAt: receivedAt))
  }
}

private extension String {
  func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
