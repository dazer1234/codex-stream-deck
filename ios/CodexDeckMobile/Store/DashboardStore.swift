import Foundation
import Observation

@Observable
@MainActor
final class DashboardStore {
  typealias ConnectionFactory = @MainActor (
    NodeProfile, String, @escaping RelayNodeUpdate
  ) -> any RelayNodeConnecting

  private(set) var profiles: [NodeProfile] = []
  private(set) var nodes: [UUID: NodeStatus] = [:]
  private(set) var keyAssignments: [String: String] = [:]
  private(set) var mobileLayoutProfile: MobileLayoutProfile = .automatic
  private(set) var showContextRings = true
  private(set) var commandFeedbackMode: CommandFeedbackMode = .minimal
  private(set) var alwaysShowCriticalErrors = true
  private(set) var commandReceipt: CommandReceipt?
  private(set) var commandHistory: [CommandReceipt] = []
  private(set) var commandSuccessPulse = 0
  private(set) var commandErrorPulse = 0
  private(set) var attentionEvents: [AttentionEvent] = []
  private(set) var attentionNotificationsEnabled = false
  private(set) var showTaskTitlesInNotifications = false
  private(set) var followedAgentReference: AgentReference?
  var selectedHostID: String?
  var showingSettings = false
  var showingAttentionCenter = false
  var presentedAgentReference: AgentReference?
  var toast: Toast?
  private(set) var replacementTargetProfileID: UUID?

  @ObservationIgnored private var connections: [UUID: any RelayNodeConnecting] = [:]
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let connectionFactory: ConnectionFactory
  @ObservationIgnored private var started = false
  @ObservationIgnored private var snapshotReceipts: [UUID: Date] = [:]
  @ObservationIgnored private var activatingAgents: Set<String> = []
  @ObservationIgnored private var receiptDismissTask: Task<Void, Never>?
  @ObservationIgnored private var attentionObservations: [String: AttentionObservation] = [:]
  @ObservationIgnored private var layoutKeyAssignments: [String: [String: String]] = [:]
  @ObservationIgnored private let liveActivityService = AgentLiveActivityService()
  @ObservationIgnored private var followedCompletionTask: Task<Void, Never>?
  private var acknowledgedCompletionRevisions: [String: Int] = [:]

  init(
    defaults: UserDefaults = .standard,
    connectionFactory: @escaping ConnectionFactory = { profile, token, update in
      RelayNodeConnection(profile: profile, token: token, update: update)
    }
  ) {
    self.defaults = defaults
    self.connectionFactory = connectionFactory
    if let stored = defaults.object(forKey: "show-context-rings") as? Bool {
      showContextRings = stored
    }
    if let stored = defaults.string(forKey: "command-feedback-mode"),
      let mode = CommandFeedbackMode(rawValue: stored)
    {
      commandFeedbackMode = mode
    }
    if let stored = defaults.object(forKey: "always-show-critical-errors") as? Bool {
      alwaysShowCriticalErrors = stored
    }
    attentionNotificationsEnabled = defaults.bool(forKey: "attention-notifications-enabled")
    showTaskTitlesInNotifications = defaults.bool(forKey: "notification-task-titles")
    if let data = defaults.data(forKey: "attention-events"),
      let decoded = try? JSONDecoder().decode([AttentionEvent].self, from: data)
    {
      attentionEvents = decoded
    }
    if let data = defaults.data(forKey: "attention-observations"),
      let decoded = try? JSONDecoder().decode([String: AttentionObservation].self, from: data)
    {
      attentionObservations = decoded
    }
    if let data = defaults.data(forKey: "acknowledged-completion-revisions"),
      let decoded = try? JSONDecoder().decode([String: Int].self, from: data)
    {
      acknowledgedCompletionRevisions = decoded
    }
    if let data = defaults.data(forKey: "node-profiles"),
      let decoded = try? JSONDecoder().decode([NodeProfile].self, from: data)
    {
      profiles = decoded
    }
    if let data = defaults.data(forKey: "followed-agent"),
      let decoded = try? JSONDecoder().decode(AgentReference.self, from: data)
    {
      followedAgentReference = decoded
    }
    selectedHostID = defaults.string(forKey: "selected-host-id")
    if let stored = defaults.string(forKey: "mobile-layout-profile"),
      let profile = MobileLayoutProfile(rawValue: stored)
    {
      mobileLayoutProfile = profile
    }
    if let data = defaults.data(forKey: "mobile-layout-key-assignments-v1"),
      let decoded = try? JSONDecoder().decode([String: [String: String]].self, from: data)
    {
      layoutKeyAssignments = decoded
    } else if let data = defaults.data(forKey: "mobile-key-assignments"),
      let decoded = try? JSONDecoder().decode([String: String].self, from: data)
    {
      layoutKeyAssignments[MobileLayoutProfile.automatic.rawValue] = decoded
    }
    keyAssignments = validatedKeyAssignments(
      layoutKeyAssignments[mobileLayoutProfile.rawValue] ?? [:])
    loadCachedSnapshots()
    publishWidgetState()
  }

  private var liveSnapshots: [HostSnapshot] {
    latestSnapshots(nodes.compactMap { profileID, status in
      guard connections[profileID] != nil,
        status.state == .ready || status.state == .degraded
      else { return nil }
      return status.snapshot
    })
  }

  private func latestSnapshots(_ values: [HostSnapshot]) -> [HostSnapshot] {
    Dictionary(grouping: values, by: \.host.hostId)
      .values
      .compactMap { $0.max(by: { $0.observedAt < $1.observedAt }) }
  }

  private func connectionPriority(_ state: NodeConnectionState) -> Int {
    switch state {
    case .ready: 3
    case .degraded: 2
    case .connecting: 1
    case .offline: 0
    }
  }

  var snapshots: [HostSnapshot] {
    liveSnapshots.isEmpty ? latestSnapshots(nodes.values.compactMap(\.snapshot)) : liveSnapshots
  }

  var agents: [RoutedAgent] {
    let live = liveSnapshots
    guard !live.isEmpty else {
      return MobileMerge.agents(
        from: snapshots, acknowledgedCompletions: acknowledgedCompletionRevisions)
    }
    let liveAgents = MobileMerge.agents(
      from: live, acknowledgedCompletions: acknowledgedCompletionRevisions)
    let liveIdentities = Set(liveAgents.map { ThreadIdentity.canonical($0.threadKey) })
    let liveHostIDs = Set(live.map { $0.host.hostId })
    let cached = latestSnapshots(
      nodes.values.compactMap(\.snapshot).filter { !liveHostIDs.contains($0.host.hostId) })
    let cachedOnly = MobileMerge.agents(
      from: cached, acknowledgedCompletions: acknowledgedCompletionRevisions
    ).filter { !liveIdentities.contains(ThreadIdentity.canonical($0.threadKey)) }
    return Array((liveAgents + cachedOnly).prefix(6)).enumerated().map { index, agent in
      RoutedAgent(
        id: index,
        threadKey: agent.threadKey,
        title: agent.title,
        status: agent.status,
        selected: agent.selected,
        activityAt: agent.activityAt,
        host: agent.host,
        sourceSlot: agent.sourceSlot,
        originPlatform: agent.originPlatform,
        ownedByHost: agent.ownedByHost,
        contextUsedPercent: agent.contextUsedPercent)
    }
  }
  var mobileAgentPlacements: [MobileAgentPlacement] {
    (0..<6).map { position in
      let agent = agents.first { $0.id == position }
      return MobileAgentPlacement(
        position: position, reference: agent.map(AgentReference.init), agent: agent)
    }
  }
  var usageSource: HostSnapshot? { MobileMerge.accountUsage(from: snapshots) }
  var codexAgentModeTitle: String {
    let authority = snapshots.first(where: { $0.host.platform == .win32 }) ?? snapshots.first
    return switch authority?.snapshot.agentSource {
    case "priority": "Priority"
    case "custom": "Fixed Assignment"
    case "recent": "Most Recent"
    case "pinned": "Pinned Tasks"
    default: "Unavailable"
    }
  }
  var connectedCount: Int {
    Set(nodes.compactMap { profileID, status in
      connections[profileID] != nil && status.state == .ready ? status.host?.hostId : nil
    }).count
  }
  var expectedCount: Int {
    let discovered = Set(nodes.values.compactMap(\.host?.hostId)).count
    let unresolved = profiles.filter { nodes[$0.id]?.host == nil }.count
    return discovered + unresolved
  }
  var hasAttention: Bool { agents.contains(where: \.isAttention) }
  var unreadAttentionCount: Int { attentionEvents.lazy.filter { !$0.isRead }.count }

  var visibleCommandReceipt: CommandReceipt? {
    guard let commandReceipt else { return nil }
    if commandFeedbackMode == .detailed { return commandReceipt }
    if commandReceipt.isFailure && alwaysShowCriticalErrors { return commandReceipt }
    return nil
  }

  var selectedHost: CodexHost? {
    let hosts = nodes.values.compactMap(\.host)
    return hosts.first(where: { $0.hostId == selectedHostID }) ?? hosts.first
  }

  var activeAgents: [RoutedAgent] {
    let activeIdentities = Set(
      snapshots.compactMap(\.snapshot.activeThreadKey).map(ThreadIdentity.canonical))
    return agents.filter {
      $0.selected || activeIdentities.contains(ThreadIdentity.canonical($0.threadKey))
    }
  }

  var activeChats: [ActiveChatSummary] {
    snapshots.compactMap { input in
      let selectedSlot = input.snapshot.slots.first { $0.selected && $0.threadKey != nil }
      guard let threadKey = input.snapshot.activeThreadKey ?? selectedSlot?.threadKey else {
        return nil
      }
      let identity = ThreadIdentity.canonical(threadKey)
      let slot = input.snapshot.slots.first {
        $0.threadKey.map(ThreadIdentity.canonical) == identity
      }
      let merged = agents.first { ThreadIdentity.canonical($0.threadKey) == identity }
      return ActiveChatSummary(
        host: input.host,
        threadKey: threadKey,
        title: input.snapshot.activeThreadTitle ?? slot?.title ?? merged?.title ?? "Selected chat",
        status: slot?.status ?? merged?.status ?? "idle")
    }
    .sorted { $0.host.platform.rawValue < $1.host.platform.rawValue }
  }

  func connectionState(for hostID: String) -> NodeConnectionState {
    nodes.compactMap { profileID, status in
      status.host?.hostId == hostID && connections[profileID] != nil ? status.state : nil
    }.max {
      connectionPriority($0) < connectionPriority($1)
    } ?? .offline
  }

  func agent(for reference: AgentReference) -> RoutedAgent? {
    agent(withIdentity: reference.threadIdentity)
  }

  func agent(withIdentity identity: String) -> RoutedAgent? {
    let canonical = ThreadIdentity.canonical(identity)
    return agents.first { ThreadIdentity.canonical($0.threadKey) == canonical }
  }

  func presentAgent(_ reference: AgentReference) {
    presentedAgentReference = reference
  }

  func isFollowing(_ agent: RoutedAgent) -> Bool {
    followedAgentReference?.threadIdentity == ThreadIdentity.canonical(agent.threadKey)
  }

  func selectMobileLayout(_ profile: MobileLayoutProfile) {
    guard mobileLayoutProfile != profile else { return }
    layoutKeyAssignments[mobileLayoutProfile.rawValue] = keyAssignments
    mobileLayoutProfile = profile
    defaults.set(profile.rawValue, forKey: "mobile-layout-profile")
    keyAssignments = validatedKeyAssignments(layoutKeyAssignments[profile.rawValue] ?? [:])
    persistKeyAssignments()
  }

  func toggleFollow(_ agent: RoutedAgent) async {
    if isFollowing(agent) {
      await unfollowAgent()
    } else {
      await follow(agent)
    }
  }

  func stopFollowing() async {
    await unfollowAgent()
  }

  func markAttentionRead(_ id: UUID) {
    guard let index = attentionEvents.firstIndex(where: { $0.id == id }),
      !attentionEvents[index].isRead
    else { return }
    attentionEvents[index].isRead = true
    persistAttentionState()
  }

  func markAllAttentionRead() {
    guard attentionEvents.contains(where: { !$0.isRead }) else { return }
    for index in attentionEvents.indices { attentionEvents[index].isRead = true }
    persistAttentionState()
  }

  func clearAttentionEvents() {
    attentionEvents.removeAll()
    persistAttentionState()
  }

  func setAttentionNotificationsEnabled(_ enabled: Bool) async {
    if enabled {
      guard await AttentionNotificationService.shared.requestAuthorization() else {
        attentionNotificationsEnabled = false
        defaults.set(false, forKey: "attention-notifications-enabled")
        show("Notifications were not allowed", kind: .error)
        return
      }
    }
    attentionNotificationsEnabled = enabled
    defaults.set(enabled, forKey: "attention-notifications-enabled")
  }

  func setShowTaskTitlesInNotifications(_ visible: Bool) {
    showTaskTitlesInNotifications = visible
    defaults.set(visible, forKey: "notification-task-titles")
  }

  func start() async {
    guard !started else { return }
    started = true
    for profile in profiles { connect(profile) }
    await reconcileFollowedActivity()
  }

  func refreshWidgetSnapshots() async -> Bool {
    guard !profiles.isEmpty else { return false }
    let refreshStartedAt = Date()
    await start()

    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(20))
    var firstReceiptAt: ContinuousClock.Instant?
    var refreshed = false

    while !Task.isCancelled && clock.now < deadline {
      let received = profiles.filter {
        snapshotReceipts[$0.id].map { $0 >= refreshStartedAt } ?? false
      }.count
      if received == profiles.count {
        refreshed = true
        break
      }
      if received > 0 {
        firstReceiptAt = firstReceiptAt ?? clock.now
        if let firstReceiptAt, clock.now - firstReceiptAt >= .seconds(4) {
          refreshed = true
          break
        }
      }
      try? await Task.sleep(for: .milliseconds(250))
    }

    if !Task.isCancelled { publishWidgetState() }
    connections.values.forEach { $0.stop(publishOffline: false) }
    connections.removeAll()
    return refreshed && !Task.isCancelled
  }

  func saveProfile(name: String, endpoint: String, token: String, replacing id: UUID? = nil) throws
  {
    guard token.utf8.count >= 32 else { throw ProfileError.shortToken }
    guard let url = normalizedEndpoint(endpoint), url.scheme == "wss" else {
      throw ProfileError.secureEndpointRequired
    }
    let profile = NodeProfile(
      id: id ?? UUID(), name: name.trimmingCharacters(in: .whitespacesAndNewlines), url: url,
      mode: .remote)
    guard !profile.name.isEmpty else { throw ProfileError.missingName }
    if let index = profiles.firstIndex(where: { $0.id == profile.id }) {
      profiles[index] = profile
    } else {
      profiles.append(profile)
    }
    try KeychainStore.set(token, for: profile.tokenKey)
    persistProfiles()
    connections[profile.id]?.stop()
    connect(profile)
  }

  func handleURL(_ url: URL) {
    if url.scheme?.lowercased() == "codexdeck", url.host?.lowercased() == "agent",
      let rawIdentity = url.pathComponents.dropFirst().first,
      !rawIdentity.isEmpty
    {
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
      let title = components?.queryItems?.first(where: { $0.name == "title" })?.value
        ?? "Codex task"
      let platformValue = components?.queryItems?.first(where: { $0.name == "platform" })?.value
      let platform = HostPlatform(rawValue: platformValue ?? "") ?? .darwin
      showingSettings = false
      showingAttentionCenter = false
      presentedAgentReference = AgentReference(
        threadIdentity: rawIdentity, fallbackTitle: title, fallbackPlatform: platform)
      return
    }
    handlePairingURL(url)
  }

  func handlePairingURL(_ url: URL) {
    do {
      let payload = try NearbyPairingPayload(url: url)
      let explicitReplacement = replacementTargetProfileID.flatMap { targetID in
        profiles.first { $0.id == targetID }
      }
      let existing = explicitReplacement
        ?? profiles.first { $0.pairedHostId?.lowercased() == payload.hostId }
      let profile = NodeProfile(
        id: existing?.id ?? UUID(), name: payload.name, url: payload.endpoint, mode: .nearby,
        pairedHostId: payload.hostId, certificateSHA256: payload.fingerprintSHA256)
      if let index = profiles.firstIndex(where: { $0.id == profile.id }) {
        connections.removeValue(forKey: profile.id)?.stop()
        profiles[index] = profile
      } else {
        profiles.append(profile)
      }
      try KeychainStore.set(payload.token, for: profile.tokenKey)
      replacementTargetProfileID = nil
      persistProfiles()
      connect(profile)
      show(
        explicitReplacement == nil
          ? "Paired with \(payload.name) nearby"
          : "Replaced \(explicitReplacement!.name) with \(payload.name)",
        kind: .success)
    } catch {
      show(error.localizedDescription, kind: .error)
    }
  }

  func beginComputerReplacement(_ profile: NodeProfile) {
    replacementTargetProfileID = profile.id
    show("Open the new Nearby pairing code to replace \(profile.name)", kind: .success)
  }

  func cancelComputerReplacement() {
    replacementTargetProfileID = nil
  }

  func updateNearbyEndpoints(_ nearby: [NearbyNode]) {
    var changed: [NodeProfile] = []
    for index in profiles.indices {
      guard profiles[index].connectionMode == .nearby,
        let hostId = profiles[index].pairedHostId,
        let fingerprint = profiles[index].certificateSHA256
      else { continue }
      let matchingHost = nearby.first {
        $0.hostId.caseInsensitiveCompare(hostId) == .orderedSame
      }
      if let matchingHost,
        matchingHost.fingerprintSHA256 != NearbyNode.normalizeFingerprint(fingerprint)
      {
        let profile = profiles[index]
        connections.removeValue(forKey: profile.id)?.stop(publishOffline: false)
        var status = nodes[profile.id] ?? NodeStatus()
        status.state = .degraded
        status.detail = "Re-pair required: certificate changed"
        status.requiresRepair = true
        nodes[profile.id] = status
        continue
      }
      guard let node = matchingHost, profiles[index].url != node.endpoint else { continue }
      profiles[index].url = node.endpoint
      changed.append(profiles[index])
    }
    guard !changed.isEmpty else { return }
    persistProfiles()
    for profile in changed {
      connections.removeValue(forKey: profile.id)?.stop()
      connect(profile)
    }
  }

  func removeProfile(_ profile: NodeProfile) {
    let removedHostID = nodes[profile.id]?.host?.hostId
    connections.removeValue(forKey: profile.id)?.stop()
    profiles.removeAll { $0.id == profile.id }
    nodes.removeValue(forKey: profile.id)
    KeychainStore.remove(profile.tokenKey)
    defaults.removeObject(forKey: "snapshot-\(profile.id.uuidString)")
    persistProfiles()
    if selectedHostID == removedHostID {
      selectedHostID = nil
      defaults.removeObject(forKey: "selected-host-id")
    }
    publishWidgetState()
    show("Removed \(profile.name)", kind: .success)
  }

  func testConnection(_ profile: NodeProfile) async throws -> RelayConnectionProbe {
    guard let connection = connections[profile.id] else {
      throw RelayConnectionError.notConnected
    }
    return try await connection.testConnection()
  }

  func reconnect(_ profile: NodeProfile) {
    connections.removeValue(forKey: profile.id)?.stop(publishOffline: false)
    var status = nodes[profile.id] ?? NodeStatus()
    status.state = .connecting
    status.detail = "Reconnecting"
    nodes[profile.id] = status
    connect(profile)
  }

  func sanitizedDiagnostics(for profile: NodeProfile, at now: Date = .now) -> String {
    let status = nodes[profile.id] ?? NodeStatus()
    let age = status.snapshotAge(at: now).map { "\(Int($0.rounded())) seconds" } ?? "never"
    let latency = status.lastRoundTripMilliseconds.map { "\($0) ms" } ?? "not tested"
    let capabilities = status.capabilities.isEmpty
      ? "not advertised" : status.capabilities.sorted().joined(separator: ", ")
    return """
    Codex Deck connection diagnostics
    Profile: \(profile.name)
    Route: \(profile.connectionMode == .nearby ? "Nearby" : "Tailscale / remote")
    Endpoint host: \(profile.url.host() ?? "unknown")
    State: \(status.state.rawValue)
    Detail: \(status.detail ?? "none")
    Platform: \(status.host?.platform.displayName ?? "unknown")
    Codex version: \(status.host?.codexVersion ?? "not advertised")
    Relay protocol: \(status.relayProtocol)
    Native bridge: \(status.bridgeKind ?? "not advertised")
    Capabilities: \(capabilities)
    Last snapshot: \(age) ago
    Round trip: \(latency)
    Certificate pinning: \(profile.connectionMode == .nearby ? "enabled" : "transport-managed")
    Repair required: \(status.requiresRepair ? "yes" : "no")
    """
  }

  func selectHost(_ host: CodexHost) {
    selectedHostID = host.hostId
    defaults.set(host.hostId, forKey: "selected-host-id")
    publishWidgetState()
  }

  func setShowContextRings(_ visible: Bool) {
    showContextRings = visible
    defaults.set(visible, forKey: "show-context-rings")
  }

  func setCommandFeedbackMode(_ mode: CommandFeedbackMode) {
    commandFeedbackMode = mode
    defaults.set(mode.rawValue, forKey: "command-feedback-mode")
    if mode != .detailed, commandReceipt?.isFailure != true { commandReceipt = nil }
  }

  func setAlwaysShowCriticalErrors(_ visible: Bool) {
    alwaysShowCriticalErrors = visible
    defaults.set(visible, forKey: "always-show-critical-errors")
    if !visible, commandFeedbackMode != .detailed { commandReceipt = nil }
  }

  func keycapID(for slot: DeviceKeySlot) -> String {
    if let assigned = keyAssignments[slot.rawValue],
      KeycapCatalog.definition(for: assigned) != nil
    {
      return assigned
    }
    if mobileLayoutProfile == .automatic {
      let selectedSnapshot = snapshots.first { $0.host.hostId == selectedHost?.hostId }
        ?? snapshots.first
      let reported = selectedSnapshot?.snapshot.layout.slots[slot.nativeActionSlot]?.keycapId
      if let reported, KeycapCatalog.definition(for: reported) != nil { return reported }
    }
    return mobileLayoutProfile.defaultKeycapID(for: slot)
  }

  func keycapDefinition(for slot: DeviceKeySlot) -> KeycapDefinition {
    KeycapCatalog.definition(for: keycapID(for: slot))
      ?? KeycapCatalog.definition(for: slot.defaultKeycapID)
      ?? KeycapCatalog.all[0]
  }

  func isKeycapCustomized(_ slot: DeviceKeySlot) -> Bool {
    keyAssignments[slot.rawValue] != nil
  }

  func assignKeycap(_ keycapID: String, to slot: DeviceKeySlot) {
    guard KeycapCatalog.definition(for: keycapID) != nil else { return }
    keyAssignments[slot.rawValue] = keycapID
    persistKeyAssignments()
  }

  func resetKeycap(_ slot: DeviceKeySlot) {
    keyAssignments.removeValue(forKey: slot.rawValue)
    persistKeyAssignments()
  }

  @discardableResult
  func importSelectedComputerLayout() -> Int {
    let selectedSnapshot = snapshots.first { $0.host.hostId == selectedHost?.hostId }
      ?? snapshots.first
    guard let selectedSnapshot else { return 0 }
    var imported: [String: String] = [:]
    for slot in DeviceKeySlot.allCases {
      guard let keycapID = selectedSnapshot.snapshot.layout.slots[slot.nativeActionSlot]?.keycapId,
        KeycapCatalog.definition(for: keycapID) != nil
      else { continue }
      imported[slot.rawValue] = keycapID
    }
    guard !imported.isEmpty else { return 0 }
    keyAssignments = imported
    persistKeyAssignments()
    return imported.count
  }

  func activate(_ requestedAgent: RoutedAgent) async {
    let identity = ThreadIdentity.canonical(requestedAgent.threadKey)
    guard activatingAgents.insert(identity).inserted else { return }
    defer { activatingAgents.remove(identity) }

    guard let agent = agent(withIdentity: identity) else {
      let receiptID = beginReceipt(
        title: requestedAgent.title, host: requestedAgent.host)
      failReceipt(receiptID, error: CommandTransactionError.taskUnavailable)
      return
    }

    acknowledgeCompletion(identity: identity)

    let receiptID = beginReceipt(title: agent.title, host: agent.host)
    if isAgentActive(identity, on: agent.host.hostId) {
      finishReceipt(
        receiptID, stage: .stateConfirmed,
        detail: "Already open on \(agent.originPlatform.displayName)")
      return
    }
    guard hasFreshSnapshot(for: agent.host.hostId) else {
      failReceipt(receiptID, error: CommandTransactionError.staleSnapshot)
      return
    }

    let startedAt = Date()
    let down = RelayCommand.agent(slot: agent.sourceSlot, threadKey: agent.threadKey, act: 1)
    let up = RelayCommand.agent(slot: agent.sourceSlot, threadKey: agent.threadKey, act: 0)
    var downAttempted = false
    do {
      downAttempted = true
      let delivery = try await deliver(down, to: agent.host.hostId)
      updateReceipt(
        receiptID, stage: .hostConfirmed,
        detail: "Delivered to \(agent.host.hostName)", requestID: delivery.requestID)
      try await Task.sleep(for: .milliseconds(90))
      let release = try await deliver(up, to: agent.host.hostId)
      updateReceipt(
        receiptID, stage: .hostConfirmed,
        detail: "Confirmed by \(agent.host.hostName)", requestID: release.requestID)

      if await waitForAgentOpen(identity, after: startedAt) {
        finishReceipt(
          receiptID, stage: .stateConfirmed,
          detail: "Opened on \(agent.originPlatform.displayName)")
      } else {
        finishReceipt(
          receiptID, stage: .warning,
          detail: "Host confirmed; a fresh task snapshot did not arrive")
      }
    } catch is CancellationError {
      if downAttempted { _ = try? await deliver(up, to: agent.host.hostId) }
      finishReceipt(receiptID, stage: .warning, detail: "Command cancelled after safe release")
    } catch {
      if downAttempted { _ = try? await deliver(up, to: agent.host.hostId) }
      failReceipt(receiptID, error: error)
    }
  }

  func trigger(_ command: RelayCommand) async {
    guard let host = selectedHost else {
      presentUnroutedFailure(title: command.feedbackTitle, error: CommandTransactionError.hostOffline)
      return
    }
    await execute(command, title: command.feedbackTitle, on: host)
  }

  func pressAction(_ slot: String) async {
    guard let host = selectedHost else {
      presentUnroutedFailure(title: "Codex action", error: CommandTransactionError.hostOffline)
      return
    }
    let title = RelayCommand.action(slot: slot, act: 1).feedbackTitle
    await executePressRelease(
      down: .action(slot: slot, act: 1), up: .action(slot: slot, act: 0),
      title: title, on: host)
  }

  func pressDeviceKey(_ slot: DeviceKeySlot) async {
    if keyAssignments[slot.rawValue] != nil || mobileLayoutProfile != .automatic {
      await trigger(.keycap(id: keycapID(for: slot)))
    } else {
      await pressAction(slot.nativeActionSlot)
    }
  }

  func handlePendingWidgetCommand() async {
    guard let request = CodexWidgetCommandHandoff.pending() else { return }
    guard request.createdAt.timeIntervalSinceNow > -300 else {
      CodexWidgetCommandHandoff.clear(request.id)
      return
    }

    for attempt in 0..<24 {
      if let host = widgetTargetHost(request.target),
        let node = nodes.first(where: { $0.value.host?.hostId == host.hostId }),
        node.value.state == .ready
      {
        let command: RelayCommand = request.command == .rateLimitReset
          ? .rateLimitReset
          : .keycap(id: request.command.rawValue)
        await execute(command, title: command.feedbackTitle, on: host)
        CodexWidgetCommandHandoff.clear(request.id)
        return
      }
      if attempt < 23 { try? await Task.sleep(for: .milliseconds(250)) }
    }
    show("The widget target is offline", kind: .error)
  }

  func pressJoystick(_ direction: String) async {
    guard let host = selectedHost else {
      presentUnroutedFailure(title: "Joystick", error: CommandTransactionError.hostOffline)
      return
    }
    await executePressRelease(
      down: .joystick(direction: direction, distance: 1),
      up: .joystick(direction: direction, distance: 0),
      title: "Joystick \(direction.capitalized)", on: host)
  }

  func pressEncoder() async {
    guard let host = selectedHost else {
      presentUnroutedFailure(title: "Encoder", error: CommandTransactionError.hostOffline)
      return
    }
    await executePressRelease(
      down: .encoder(act: 1), up: .encoder(act: 0), title: "Encoder", on: host)
  }

  func resetRateLimit() async {
    guard let source = usageSource else {
      presentUnroutedFailure(title: "Rate-limit reset", error: CommandTransactionError.staleSnapshot)
      return
    }
    await execute(.rateLimitReset, title: "Rate-limit reset", on: source.host)
  }

  private func deliver(_ command: RelayCommand, to hostID: String) async throws -> RelayDelivery {
    let candidates = nodes.compactMap { profileID, status -> (NodeStatus, any RelayNodeConnecting)? in
      guard status.host?.hostId == hostID,
        status.state == .ready || status.state == .degraded,
        let connection = connections[profileID]
      else { return nil }
      return (status, connection)
    }.sorted { left, right in
      if connectionPriority(left.0.state) != connectionPriority(right.0.state) {
        return connectionPriority(left.0.state) > connectionPriority(right.0.state)
      }
      return (left.0.lastSnapshotReceivedAt ?? .distantPast)
        > (right.0.lastSnapshotReceivedAt ?? .distantPast)
    }
    guard let connection = candidates.first?.1 else {
      throw CommandTransactionError.hostOffline
    }
    return try await connection.send(command)
  }

  private func execute(_ command: RelayCommand, title: String, on host: CodexHost) async {
    let receiptID = beginReceipt(title: title, host: host)
    do {
      let delivery = try await deliver(command, to: host.hostId)
      finishReceipt(
        receiptID, stage: .stateConfirmed,
        detail: "Executed by \(host.platform.displayName)", requestID: delivery.requestID)
    } catch is CancellationError {
      finishReceipt(receiptID, stage: .warning, detail: "Command cancelled")
    } catch {
      failReceipt(receiptID, error: error)
    }
  }

  private func executePressRelease(
    down: RelayCommand, up: RelayCommand, title: String, on host: CodexHost
  ) async {
    let receiptID = beginReceipt(title: title, host: host)
    var downAttempted = false
    do {
      downAttempted = true
      let delivery = try await deliver(down, to: host.hostId)
      updateReceipt(
        receiptID, stage: .hostConfirmed, detail: "Delivered to \(host.hostName)",
        requestID: delivery.requestID)
      try await Task.sleep(for: .milliseconds(90))
      let release = try await deliver(up, to: host.hostId)
      finishReceipt(
        receiptID, stage: .stateConfirmed,
        detail: "Executed by \(host.platform.displayName)", requestID: release.requestID)
    } catch is CancellationError {
      if downAttempted { _ = try? await deliver(up, to: host.hostId) }
      finishReceipt(receiptID, stage: .warning, detail: "Command cancelled after safe release")
    } catch {
      if downAttempted { _ = try? await deliver(up, to: host.hostId) }
      failReceipt(receiptID, error: error)
    }
  }

  private func hasFreshSnapshot(for hostID: String, at now: Date = .now) -> Bool {
    nodes.compactMap { profileID, status -> Date? in
      guard status.host?.hostId == hostID,
        status.state == .ready || status.state == .degraded
      else { return nil }
      return snapshotReceipts[profileID] ?? status.lastSnapshotReceivedAt
    }
    .contains { now.timeIntervalSince($0) <= 8 }
  }

  private func isAgentActive(_ identity: String, on hostID: String) -> Bool {
    snapshots.contains { input in
      guard input.host.hostId == hostID else { return false }
      if input.snapshot.activeThreadKey.map(ThreadIdentity.canonical) == identity { return true }
      return input.snapshot.slots.contains {
        $0.selected && $0.threadKey.map(ThreadIdentity.canonical) == identity
      }
    }
  }

  private func waitForAgentOpen(_ identity: String, after startedAt: Date) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(4))
    while !Task.isCancelled && clock.now < deadline {
      let confirmed = nodes.contains { profileID, status in
        guard let receivedAt = snapshotReceipts[profileID], receivedAt >= startedAt,
          let snapshot = status.snapshot
        else { return false }
        if snapshot.snapshot.activeThreadKey.map(ThreadIdentity.canonical) == identity {
          return true
        }
        return snapshot.snapshot.slots.contains {
          $0.selected && $0.threadKey.map(ThreadIdentity.canonical) == identity
        }
      }
      if confirmed { return true }
      try? await Task.sleep(for: .milliseconds(100))
    }
    return false
  }

  private func beginReceipt(title: String, host: CodexHost) -> UUID {
    receiptDismissTask?.cancel()
    let receipt = CommandReceipt(
      id: UUID(), title: title, hostName: host.hostName, hostPlatform: host.platform,
      startedAt: .now, stage: .sending, detail: "Sending to \(host.hostName)", requestID: nil)
    commandReceipt = receipt
    return receipt.id
  }

  private func presentUnroutedFailure(title: String, error: Error) {
    let fallback = CodexHost(hostId: "offline", hostName: "Codex", platform: .darwin)
    let receiptID = beginReceipt(title: title, host: fallback)
    failReceipt(receiptID, error: error)
  }

  private func updateReceipt(
    _ id: UUID, stage: CommandReceiptStage, detail: String, requestID: String? = nil
  ) {
    guard var receipt = commandReceipt, receipt.id == id else { return }
    receipt.stage = stage
    receipt.detail = detail
    if let requestID { receipt.requestID = requestID }
    commandReceipt = receipt
  }

  private func finishReceipt(
    _ id: UUID, stage: CommandReceiptStage, detail: String, requestID: String? = nil
  ) {
    updateReceipt(id, stage: stage, detail: detail, requestID: requestID)
    guard let receipt = commandReceipt, receipt.id == id else { return }
    commandHistory.removeAll { $0.id == id }
    commandHistory.insert(receipt, at: 0)
    if commandHistory.count > 20 { commandHistory.removeLast(commandHistory.count - 20) }

    switch stage {
    case .stateConfirmed:
      if commandFeedbackMode != .off { commandSuccessPulse += 1 }
    case .failed:
      if commandFeedbackMode != .off || alwaysShowCriticalErrors { commandErrorPulse += 1 }
    default:
      break
    }
    scheduleReceiptDismissal(id: id, after: stage == .failed ? .seconds(5) : .seconds(3))
  }

  private func failReceipt(_ id: UUID, error: Error) {
    finishReceipt(id, stage: .failed, detail: error.localizedDescription)
  }

  private func scheduleReceiptDismissal(id: UUID, after delay: Duration) {
    receiptDismissTask?.cancel()
    receiptDismissTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled, self?.commandReceipt?.id == id else { return }
      self?.commandReceipt = nil
    }
  }

  private func connect(_ profile: NodeProfile) {
    guard connections[profile.id] == nil else { return }
    do {
      guard let token = try KeychainStore.value(for: profile.tokenKey) else {
        nodes[profile.id] = NodeStatus(state: .offline, detail: "Token missing")
        return
      }
      let connection = connectionFactory(profile, token) {
        [weak self] id, status in
        guard let self else { return }
        if let expectedHostID = profile.pairedHostId,
          let authenticatedHostID = status.host?.hostId,
          expectedHostID.caseInsensitiveCompare(authenticatedHostID) != .orderedSame
        {
          self.connections.removeValue(forKey: id)?.stop(publishOffline: false)
          self.nodes[id] = NodeStatus(
            state: .degraded, host: status.host, snapshot: status.snapshot,
            detail: "Re-pair required: computer identity changed",
            lastSnapshotReceivedAt: status.lastSnapshotReceivedAt,
            requiresRepair: true)
          return
        }
        let firstLiveSnapshot = status.lastSnapshotReceivedAt != nil
          && self.snapshotReceipts[id] == nil
        if let receivedAt = status.lastSnapshotReceivedAt {
          self.snapshotReceipts[id] = receivedAt
          Task { @MainActor [weak self] in await self?.refreshFollowedActivity() }
        }
        if let current = self.nodes[id],
          current.state == status.state,
          current.host == status.host,
          current.detail == status.detail,
          current.snapshot?.snapshot == status.snapshot?.snapshot,
          current.lastRoundTripMilliseconds == status.lastRoundTripMilliseconds,
          current.capabilities == status.capabilities
        {
          return
        }
        let previouslyActive = self.currentActiveThreadIdentities()
        self.nodes[id] = status
        let newlyActive = self.currentActiveThreadIdentities().subtracting(previouslyActive)
        for identity in newlyActive { self.acknowledgeCompletion(identity: identity) }
        if let snapshot = status.snapshot {
          self.cache(snapshot, for: id)
        }
        if self.selectedHostID == nil, let host = status.host { self.selectHost(host) }
        self.markDuplicateConnections(for: id)
        self.processAttentionEvents(suppressEvents: firstLiveSnapshot)
        self.publishWidgetState()
        Task { @MainActor [weak self] in await self?.refreshFollowedActivity() }
      }
      connections[profile.id] = connection
      connection.start()
    } catch {
      nodes[profile.id] = NodeStatus(state: .offline, detail: error.localizedDescription)
    }
  }

  private func markDuplicateConnections(for profileID: UUID) {
    guard let hostID = nodes[profileID]?.host?.hostId else { return }
    let matches = profiles.filter {
      nodes[$0.id]?.host?.hostId.caseInsensitiveCompare(hostID) == .orderedSame
    }
    guard matches.count > 1 else { return }
    let keeper = matches.first(where: { $0.pairedHostId?.caseInsensitiveCompare(hostID) == .orderedSame })
      ?? matches[0]
    for duplicate in matches where duplicate.id != keeper.id {
      connections.removeValue(forKey: duplicate.id)?.stop(publishOffline: false)
      var status = nodes[duplicate.id] ?? NodeStatus()
      status.state = .degraded
      status.detail = "Duplicate connection to \(status.host?.hostName ?? keeper.name)"
      status.requiresRepair = true
      nodes[duplicate.id] = status
    }
  }

  private func normalizedEndpoint(_ input: String) -> URL? {
    var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if !value.contains("://") { value = "wss://\(value)" }
    return URL(string: value)
  }

  private func persistProfiles() {
    defaults.set(try? JSONEncoder().encode(profiles), forKey: "node-profiles")
  }

  private func persistKeyAssignments() {
    layoutKeyAssignments[mobileLayoutProfile.rawValue] = keyAssignments
    defaults.set(
      try? JSONEncoder().encode(layoutKeyAssignments),
      forKey: "mobile-layout-key-assignments-v1")
  }

  private func validatedKeyAssignments(_ assignments: [String: String]) -> [String: String] {
    assignments.filter { slot, keycapID in
      DeviceKeySlot(rawValue: slot) != nil && KeycapCatalog.definition(for: keycapID) != nil
    }
  }

  private func follow(_ agent: RoutedAgent) async {
    let reference = AgentReference(agent: agent)
    let state = activityState(for: reference, agent: agent)
    do {
      try await liveActivityService.start(reference: reference, state: state)
      followedAgentReference = reference
      defaults.set(try? JSONEncoder().encode(reference), forKey: "followed-agent")
      scheduleCompletionIfNeeded(for: agent)
      show("Following \(agent.title)", kind: .success)
    } catch {
      show(error.localizedDescription, kind: .error)
    }
  }

  private func unfollowAgent(completed: Bool = false) async {
    guard let reference = followedAgentReference else { return }
    followedCompletionTask?.cancel()
    followedCompletionTask = nil
    let finalState = activityState(for: reference, agent: agent(for: reference))
    await liveActivityService.end(
      reference: reference, finalState: finalState, immediately: true)
    followedAgentReference = nil
    defaults.removeObject(forKey: "followed-agent")
    if !completed { show("Stopped following this task", kind: .success) }
  }

  private func reconcileFollowedActivity() async {
    guard let reference = followedAgentReference else { return }
    guard liveActivityService.hasActivity(for: reference.threadIdentity) else {
      followedAgentReference = nil
      defaults.removeObject(forKey: "followed-agent")
      return
    }
    await refreshFollowedActivity()
  }

  private func refreshFollowedActivity() async {
    guard let reference = followedAgentReference else { return }
    let currentAgent = agent(for: reference)
    await liveActivityService.update(
      reference: reference,
      state: activityState(for: reference, agent: currentAgent))
    if let currentAgent {
      scheduleCompletionIfNeeded(for: currentAgent)
    } else {
      followedCompletionTask?.cancel()
      followedCompletionTask = nil
    }
  }

  private func activityState(
    for reference: AgentReference,
    agent: RoutedAgent?
  ) -> CodexAgentActivityAttributes.ContentState {
    let now = Date()
    guard let agent else {
      return CodexAgentActivityAttributes.ContentState(
        title: reference.fallbackTitle,
        status: "unavailable",
        hostName: reference.fallbackPlatform.displayName,
        hostLabel: reference.fallbackPlatform.shortLabel,
        activityAt: nil,
        contextUsedPercent: nil,
        updatedAt: now,
        isFresh: false)
    }
    let activityAt: Date? = agent.activityAt > 0
      ? Date(timeIntervalSince1970: agent.activityAt > 10_000_000_000
        ? agent.activityAt / 1_000 : agent.activityAt)
      : nil
    return CodexAgentActivityAttributes.ContentState(
      title: agent.title,
      status: agent.status,
      hostName: agent.host.hostName,
      hostLabel: agent.originPlatform.shortLabel,
      activityAt: activityAt,
      contextUsedPercent: agent.contextUsedPercent,
      updatedAt: now,
      isFresh: hasFreshSnapshot(for: agent.host.hostId, at: now))
  }

  private func scheduleCompletionIfNeeded(for agent: RoutedAgent) {
    let completed = ["complete", "completed", "done"].contains(agent.status)
    guard completed else {
      followedCompletionTask?.cancel()
      followedCompletionTask = nil
      return
    }
    guard followedCompletionTask == nil else { return }
    let identity = ThreadIdentity.canonical(agent.threadKey)
    followedCompletionTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(60))
      guard !Task.isCancelled, let self,
        self.followedAgentReference?.threadIdentity == identity,
        let current = self.agent(withIdentity: identity),
        ["complete", "completed", "done"].contains(current.status)
      else { return }
      await self.unfollowAgent(completed: true)
    }
  }

  private func processAttentionEvents(suppressEvents: Bool) {
    let now = Date()
    var created: [AttentionEvent] = []
    for agent in agents {
      let identity = ThreadIdentity.canonical(agent.threadKey)
      let kind = AttentionEventKind(status: agent.status)
      let revision = completionRevision(for: identity)
      let prior = attentionObservations[identity]
      attentionObservations[identity] = AttentionObservation(
        kind: kind, completionRevision: revision, observedAt: now)

      guard !suppressEvents, let prior, let kind else { continue }
      let enteredKind = prior.kind != kind
      let newCompletion = kind == .completion && revision != nil
        && prior.completionRevision != revision
      guard enteredKind || newCompletion else { continue }

      let event = AttentionEvent(
        id: UUID(), kind: kind, threadIdentity: identity, title: agent.title,
        hostID: agent.host.hostId, hostName: agent.host.hostName,
        platform: agent.originPlatform, occurredAt: now, isRead: false)
      attentionEvents.insert(event, at: 0)
      created.append(event)
    }

    let cutoff = now.addingTimeInterval(-7 * 24 * 60 * 60)
    attentionEvents = Array(attentionEvents.filter { $0.occurredAt >= cutoff }.prefix(100))
    attentionObservations = attentionObservations.filter { $0.value.observedAt >= cutoff }
    persistAttentionState()

    guard attentionNotificationsEnabled else { return }
    for event in created {
      let showTitle = showTaskTitlesInNotifications
      Task { await AttentionNotificationService.shared.schedule(event, showTaskTitle: showTitle) }
    }
  }

  private func completionRevision(for identity: String) -> Int? {
    snapshots
      .flatMap { $0.snapshot.hostSessions ?? [] }
      .filter { ThreadIdentity.canonical($0.threadId) == identity }
      .compactMap(\.completionRevision)
      .max()
  }

  private func persistAttentionState() {
    defaults.set(try? JSONEncoder().encode(attentionEvents), forKey: "attention-events")
    defaults.set(
      try? JSONEncoder().encode(attentionObservations), forKey: "attention-observations")
  }

  private func acknowledgeCompletion(identity: String) {
    var changed = false
    for snapshot in snapshots {
      for session in snapshot.snapshot.hostSessions ?? []
      where ThreadIdentity.canonical(session.threadId) == identity
        && session.status == "complete"
    {
        guard let revision = session.completionRevision else { continue }
        let key = MobileMerge.completionKey(
          hostID: snapshot.host.hostId, identity: identity)
        if acknowledgedCompletionRevisions[key] != revision {
          acknowledgedCompletionRevisions[key] = revision
          changed = true
        }
      }
    }
    if changed { persistAcknowledgedCompletions() }
  }

  private func currentActiveThreadIdentities() -> Set<String> {
    Set(snapshots.flatMap { snapshot in
      ([snapshot.snapshot.activeThreadKey].compactMap { $0 }
        + snapshot.snapshot.slots.compactMap { $0.selected ? $0.threadKey : nil })
        .map(ThreadIdentity.canonical)
    })
  }

  private func persistAcknowledgedCompletions() {
    if acknowledgedCompletionRevisions.count > 256 {
      acknowledgedCompletionRevisions = Dictionary(
        uniqueKeysWithValues: acknowledgedCompletionRevisions.suffix(256))
    }
    defaults.set(
      try? JSONEncoder().encode(acknowledgedCompletionRevisions),
      forKey: "acknowledged-completion-revisions")
  }

  private func cache(_ snapshot: HostSnapshot, for id: UUID) {
    defaults.set(try? JSONEncoder().encode(snapshot), forKey: "snapshot-\(id.uuidString)")
  }

  private func loadCachedSnapshots() {
    for profile in profiles {
      guard let data = defaults.data(forKey: "snapshot-\(profile.id.uuidString)"),
        let snapshot = try? JSONDecoder().decode(HostSnapshot.self, from: data)
      else { continue }
      nodes[profile.id] = NodeStatus(
        state: .offline, host: snapshot.host, snapshot: snapshot, detail: "Last known")
    }
  }

  private func widgetTargetHost(_ target: CodexWidgetHostTarget) -> CodexHost? {
    switch target {
    case .selected:
      return selectedHost
    case .mac:
      return nodes.values.compactMap(\.host).first { $0.platform == .darwin }
    case .windows:
      return nodes.values.compactMap(\.host).first { $0.platform == .win32 }
    }
  }

  private func publishWidgetState() {
    let widgetAgents = agents.prefix(6).map { agent in
      CodexWidgetAgent(
        id: "\(agent.host.hostId):\(agent.threadKey)",
        title: agent.title,
        status: agent.status,
        hostName: agent.host.hostName,
        hostLabel: agent.originPlatform.shortLabel,
        activityAt: Date(timeIntervalSince1970: agent.activityAt / 1_000),
        selected: agent.selected,
        contextUsedPercent: agent.contextUsedPercent,
        hostConnected: [.ready, .degraded].contains(connectionState(for: agent.host.hostId)))
    }
    let activeStatuses = Set([
      "working", "thinking", "approval", "awaiting-approval", "awaiting-response", "error",
      "unread",
    ])
    let activeAgent = widgetAgents
      .filter { $0.selected || activeStatuses.contains($0.status) }
      .max { $0.activityAt < $1.activityAt }
      ?? widgetAgents.max { $0.activityAt < $1.activityAt }
    let usage = usageSource?.snapshot.usage.map { value in
      CodexWidgetUsage(
        fiveHourRemaining: value.windows.first { $0.kind == "five-hour" }?.remainingPercent,
        weeklyRemaining: value.windows.first { $0.kind == "weekly" }?.remainingPercent,
        resetCreditsAvailable: value.resetCreditsAvailable ?? 0,
        resetCreditsApplicable: value.resetCreditsApplicable,
        observedAt: Date(timeIntervalSince1970: value.observedAt / 1_000))
    }
    let observedAt = snapshots.map(\.observedAt).max()
      .map { Date(timeIntervalSince1970: $0 / 1_000) }
      ?? .now
    CodexWidgetStateStore.save(
      CodexWidgetState(
        updatedAt: observedAt,
        connectedCount: connectedCount,
        selectedHostID: selectedHost?.hostId,
        activeAgent: activeAgent,
        agents: widgetAgents,
        usage: usage))
  }

  private func show(_ message: String, kind: Toast.Kind) {
    toast = Toast(message: message, kind: kind)
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      if self?.toast?.message == message { self?.toast = nil }
    }
  }

}

private extension RelayCommand {
  var feedbackTitle: String {
    switch self {
    case .agent:
      "Open task"
    case .action(let slot, _):
      [
        "ACT06": "Fast mode", "ACT07": "Approve", "ACT08": "Reject",
        "ACT09": "Fork task", "ACT10_ACT11": "Voice", "ACT12": "Codex",
      ][slot] ?? "Codex action"
    case .joystick(let direction, _):
      "Joystick \(direction.capitalized)"
    case .encoder:
      "Encoder"
    case .reasoning(let direction):
      direction == "increase" ? "Increase reasoning" : "Decrease reasoning"
    case .rateLimitReset:
      "Rate-limit reset"
    case .keycap(let id):
      KeycapCatalog.definition(for: id)?.name ?? "Codex key"
    }
  }
}

struct Toast: Equatable {
  enum Kind { case success, error }
  let message: String
  let kind: Kind
}

enum ProfileError: LocalizedError {
  case shortToken
  case secureEndpointRequired
  case missingName

  var errorDescription: String? {
    switch self {
    case .shortToken: "Relay token must contain at least 32 bytes."
    case .secureEndpointRequired: "Use a secure wss:// Tailscale endpoint."
    case .missingName: "Give this computer a name."
    }
  }
}
