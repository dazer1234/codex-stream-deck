import Foundation

enum HostPlatform: String, Codable, Sendable {
  case win32
  case darwin

  var shortLabel: String { self == .darwin ? "M" : "W" }
  var displayName: String { self == .darwin ? "Mac" : "Windows" }
  var opposite: HostPlatform { self == .darwin ? .win32 : .darwin }
}

struct CodexHost: Codable, Hashable, Sendable, Identifiable {
  let hostId: String
  let hostName: String
  let platform: HostPlatform
  let codexVersion: String?

  init(
    hostId: String, hostName: String, platform: HostPlatform, codexVersion: String? = nil
  ) {
    self.hostId = hostId
    self.hostName = hostName
    self.platform = platform
    self.codexVersion = codexVersion
  }
  var id: String { hostId }
}

struct AgentSlot: Codable, Hashable, Sendable, Identifiable {
  let id: Int
  let threadKey: String?
  let title: String?
  let status: String
  let selected: Bool
  let activityAt: Double?
  let ownedByHost: Bool?
  let contextUsedPercent: Double?

  init(
    id: Int, threadKey: String?, title: String?, status: String, selected: Bool,
    activityAt: Double?, ownedByHost: Bool?, contextUsedPercent: Double? = nil
  ) {
    self.id = id
    self.threadKey = threadKey
    self.title = title
    self.status = status
    self.selected = selected
    self.activityAt = activityAt
    self.ownedByHost = ownedByHost
    self.contextUsedPercent = contextUsedPercent
  }
}

struct HostSessionPresence: Codable, Hashable, Sendable {
  let threadId: String
  let activityAt: Double
  let status: String
  let completionRevision: Int?
  let contextUsedPercent: Double?

  init(
    threadId: String, activityAt: Double, status: String, completionRevision: Int?,
    contextUsedPercent: Double? = nil
  ) {
    self.threadId = threadId
    self.activityAt = activityAt
    self.status = status
    self.completionRevision = completionRevision
    self.contextUsedPercent = contextUsedPercent
  }
}

struct UsageWindow: Codable, Hashable, Sendable, Identifiable {
  let id: String
  let kind: String
  let usedPercent: Double
  let remainingPercent: Double
  let windowDurationMins: Double?
  let resetsAt: Double?
}

struct UsageSnapshot: Codable, Hashable, Sendable {
  let windows: [UsageWindow]
  let observedAt: Double
  let resetCreditsAvailable: Int?
  let resetCreditsApplicable: Int?
}

struct MicroLayout: Codable, Hashable, Sendable {
  struct Slot: Codable, Hashable, Sendable {
    let keycapId: String
    let commandId: String?
  }

  let version: Int
  let slots: [String: Slot]
}

struct MicroSnapshot: Codable, Hashable, Sendable {
  let slots: [AgentSlot]
  let activeThreadKey: String?
  let activeThreadTitle: String?
  let layout: MicroLayout
  let agentSource: String
  let lightingAutoOff: String
  let theme: String
  let usage: UsageSnapshot?
  let hostSessions: [HostSessionPresence]?
}

struct ActiveChatSummary: Identifiable, Hashable, Sendable {
  let host: CodexHost
  let threadKey: String
  let title: String
  let status: String
  var id: String { "\(host.hostId):\(threadKey)" }
}

struct HostSnapshot: Codable, Hashable, Sendable {
  let host: CodexHost
  let observedAt: Double
  let snapshot: MicroSnapshot

  func normalizedToReceiptTime(_ receivedAt: Double) -> HostSnapshot {
    guard receivedAt.isFinite, receivedAt > 0, observedAt.isFinite, observedAt > 0 else {
      return self
    }
    let offset = receivedAt - observedAt
    func shifted(_ value: Double?) -> Double? {
      guard let value, value.isFinite, value > 0 else { return value }
      return max(1, value + offset)
    }
    let normalizedUsage = snapshot.usage.map { usage in
      UsageSnapshot(
        windows: usage.windows.map { window in
          UsageWindow(
            id: window.id,
            kind: window.kind,
            usedPercent: window.usedPercent,
            remainingPercent: window.remainingPercent,
            windowDurationMins: window.windowDurationMins,
            resetsAt: shifted(window.resetsAt))
        },
        observedAt: shifted(usage.observedAt) ?? receivedAt,
        resetCreditsAvailable: usage.resetCreditsAvailable,
        resetCreditsApplicable: usage.resetCreditsApplicable)
    }
    return HostSnapshot(
      host: host,
      observedAt: receivedAt,
      snapshot: MicroSnapshot(
        slots: snapshot.slots.map { slot in
          AgentSlot(
            id: slot.id,
            threadKey: slot.threadKey,
            title: slot.title,
            status: slot.status,
            selected: slot.selected,
            activityAt: shifted(slot.activityAt),
            ownedByHost: slot.ownedByHost,
            contextUsedPercent: slot.contextUsedPercent)
        },
        activeThreadKey: snapshot.activeThreadKey,
        activeThreadTitle: snapshot.activeThreadTitle,
        layout: snapshot.layout,
        agentSource: snapshot.agentSource,
        lightingAutoOff: snapshot.lightingAutoOff,
        theme: snapshot.theme,
        usage: normalizedUsage,
        hostSessions: snapshot.hostSessions?.map { session in
          HostSessionPresence(
            threadId: session.threadId,
            activityAt: shifted(session.activityAt) ?? receivedAt,
            status: session.status,
            completionRevision: session.completionRevision,
            contextUsedPercent: session.contextUsedPercent)
        }))
  }
}

enum ThreadIdentity {
  static func canonical(_ threadKey: String) -> String {
    threadKey
      .split(separator: ":")
      .last
      .map(String.init)?
      .lowercased() ?? threadKey.lowercased()
  }
}

struct AgentReference: Identifiable, Codable, Hashable, Sendable {
  let threadIdentity: String
  let fallbackTitle: String
  let fallbackPlatform: HostPlatform

  init(agent: RoutedAgent) {
    threadIdentity = ThreadIdentity.canonical(agent.threadKey)
    fallbackTitle = agent.title
    fallbackPlatform = agent.originPlatform
  }

  init(threadIdentity: String, fallbackTitle: String, fallbackPlatform: HostPlatform) {
    self.threadIdentity = ThreadIdentity.canonical(threadIdentity)
    self.fallbackTitle = fallbackTitle
    self.fallbackPlatform = fallbackPlatform
  }

  var id: String { threadIdentity }
}

struct RoutedAgent: Identifiable, Hashable, Sendable {
  let id: Int
  let threadKey: String
  let title: String
  let status: String
  let selected: Bool
  let activityAt: Double
  let host: CodexHost
  let sourceSlot: Int
  let originPlatform: HostPlatform
  let ownedByHost: Bool?
  let contextUsedPercent: Double?

  init(
    id: Int, threadKey: String, title: String, status: String, selected: Bool,
    activityAt: Double, host: CodexHost, sourceSlot: Int, originPlatform: HostPlatform,
    ownedByHost: Bool?, contextUsedPercent: Double? = nil
  ) {
    self.id = id
    self.threadKey = threadKey
    self.title = title
    self.status = status
    self.selected = selected
    self.activityAt = activityAt
    self.host = host
    self.sourceSlot = sourceSlot
    self.originPlatform = originPlatform
    self.ownedByHost = ownedByHost
    self.contextUsedPercent = contextUsedPercent
  }

  var isAttention: Bool {
    ["approval", "awaiting-approval", "awaiting-response", "error", "unread"].contains(status)
  }
}

enum RelayCommand: Encodable, Sendable {
  case agent(slot: Int, threadKey: String, act: Int)
  case action(slot: String, act: Int)
  case joystick(direction: String, distance: Int)
  case encoder(act: Int)
  case reasoning(direction: String)
  case rateLimitReset
  case keycap(id: String)

  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .agent(let slot, let threadKey, let act):
      try values.encode("agent", forKey: .kind)
      try values.encode(slot, forKey: .slot)
      try values.encode(threadKey, forKey: .threadKey)
      try values.encode(act, forKey: .act)
    case .action(let slot, let act):
      try values.encode("action", forKey: .kind)
      try values.encode(slot, forKey: .slot)
      try values.encode(act, forKey: .act)
    case .joystick(let direction, let distance):
      try values.encode("joystick", forKey: .kind)
      try values.encode(direction, forKey: .direction)
      try values.encode(distance, forKey: .distance)
    case .encoder(let act):
      try values.encode("encoder", forKey: .kind)
      try values.encode(act, forKey: .act)
    case .reasoning(let direction):
      try values.encode("reasoning", forKey: .kind)
      try values.encode(direction, forKey: .direction)
    case .rateLimitReset:
      try values.encode("rate-limit-reset", forKey: .kind)
    case .keycap(let id):
      try values.encode("keycap", forKey: .kind)
      try values.encode(id, forKey: .keycapId)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case kind, slot, threadKey, act, direction, distance, keycapId
  }
}

enum NodeConnectionMode: String, Codable, Sendable {
  case remote
  case nearby
}

struct NodeProfile: Codable, Hashable, Identifiable, Sendable {
  let id: UUID
  var name: String
  var url: URL
  var mode: NodeConnectionMode?
  var pairedHostId: String?
  var certificateSHA256: String?
  var tokenKey: String { "relay-token-\(id.uuidString)" }

  init(
    id: UUID, name: String, url: URL, mode: NodeConnectionMode? = nil,
    pairedHostId: String? = nil, certificateSHA256: String? = nil
  ) {
    self.id = id
    self.name = name
    self.url = url
    self.mode = mode
    self.pairedHostId = pairedHostId
    self.certificateSHA256 = certificateSHA256
  }

  var connectionMode: NodeConnectionMode { mode ?? .remote }
}

enum NodeConnectionState: String, Sendable {
  case connecting
  case ready
  case degraded
  case offline
}

struct NodeStatus: Sendable {
  var state: NodeConnectionState = .offline
  var host: CodexHost?
  var snapshot: HostSnapshot?
  var detail: String?
  var changedAt = Date()
  var lastSnapshotReceivedAt: Date?
  var relayProtocol = 1
  var capabilities: [String] = []
  var bridgeKind: String?
  var lastRoundTripMilliseconds: Int?
  var lastConnectionTestAt: Date?
  var requiresRepair = false

  func snapshotAge(at now: Date = .now) -> TimeInterval? {
    lastSnapshotReceivedAt.map { max(0, now.timeIntervalSince($0)) }
  }
}

struct RelayConnectionProbe: Hashable, Sendable {
  let elapsedMilliseconds: Int
  let measuredAt: Date
}

struct RelayReadyMetadata: Decodable, Sendable {
  let capabilities: [String]
  let bridge: String?

  init(capabilities: [String] = [], bridge: String? = nil) {
    self.capabilities = capabilities
    self.bridge = bridge
  }
}

struct RelayDelivery: Hashable, Sendable {
  let requestID: String
  let elapsedMilliseconds: Int
}

enum CommandFeedbackMode: String, CaseIterable, Codable, Identifiable, Sendable {
  case minimal
  case detailed
  case off

  var id: String { rawValue }
  var title: String {
    switch self {
    case .minimal: "Minimal"
    case .detailed: "Detailed"
    case .off: "Off"
    }
  }
}

enum CommandReceiptStage: String, Sendable {
  case sending
  case hostConfirmed
  case stateConfirmed
  case warning
  case failed

  var isTerminal: Bool {
    switch self {
    case .stateConfirmed, .warning, .failed: true
    case .sending, .hostConfirmed: false
    }
  }
}

struct CommandReceipt: Identifiable, Equatable, Sendable {
  let id: UUID
  let title: String
  let hostName: String
  let hostPlatform: HostPlatform
  let startedAt: Date
  var stage: CommandReceiptStage
  var detail: String
  var requestID: String?

  var isFailure: Bool { stage == .failed }
}

enum CommandTransactionError: LocalizedError {
  case hostOffline
  case staleSnapshot
  case taskUnavailable

  var errorDescription: String? {
    switch self {
    case .hostOffline: "That computer is offline."
    case .staleSnapshot: "The app has an old snapshot. Wait for Codex to reconnect and try again."
    case .taskUnavailable: "That task is no longer available."
    }
  }
}

enum RelayServerEvent: Decodable, Sendable {
  case ready(CodexHost, RelayReadyMetadata)
  case snapshot(HostSnapshot)
  case health(CodexHost, String, Double)
  case result(String, Bool, String?)

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    guard try values.decode(Int.self, forKey: .protocol) == 1 else {
      throw DecodingError.dataCorruptedError(
        forKey: .protocol, in: values, debugDescription: "Unsupported relay protocol")
    }
    switch try values.decode(String.self, forKey: .type) {
    case "ready":
      self = .ready(
        try values.decode(CodexHost.self, forKey: .host),
        RelayReadyMetadata(
          capabilities: try values.decodeIfPresent([String].self, forKey: .capabilities) ?? [],
          bridge: try values.decodeIfPresent(String.self, forKey: .bridge)))
    case "snapshot":
      self = .snapshot(
        HostSnapshot(
          host: try values.decode(CodexHost.self, forKey: .host),
          observedAt: try values.decode(Double.self, forKey: .observedAt),
          snapshot: try values.decode(MicroSnapshot.self, forKey: .snapshot)
        ))
    case "health":
      self = .health(
        try values.decode(CodexHost.self, forKey: .host),
        try values.decode(String.self, forKey: .reason),
        try values.decode(Double.self, forKey: .observedAt)
      )
    case "result":
      self = .result(
        try values.decode(String.self, forKey: .requestId),
        try values.decode(Bool.self, forKey: .ok),
        try values.decodeIfPresent(String.self, forKey: .error)
      )
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type, in: values, debugDescription: "Unknown relay message")
    }
  }

  private enum CodingKeys: String, CodingKey {
    case type, `protocol`, host, observedAt, snapshot, reason, requestId, ok, error,
      capabilities, bridge
  }
}
