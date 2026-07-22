import Foundation
import WidgetKit

struct CodexWidgetAgent: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let title: String
  let status: String
  let hostName: String
  let hostLabel: String
  let activityAt: Date
  let selected: Bool
  let contextUsedPercent: Double?
  let hostConnected: Bool?

  init(
    id: String, title: String, status: String, hostName: String, hostLabel: String,
    activityAt: Date, selected: Bool, contextUsedPercent: Double? = nil,
    hostConnected: Bool = true
  ) {
    self.id = id
    self.title = title
    self.status = status
    self.hostName = hostName
    self.hostLabel = hostLabel
    self.activityAt = activityAt
    self.selected = selected
    self.contextUsedPercent = contextUsedPercent
    self.hostConnected = hostConnected
  }

  var isHostConnected: Bool { hostConnected ?? true }
}

struct CodexWidgetUsage: Codable, Equatable, Sendable {
  let fiveHourRemaining: Double?
  let weeklyRemaining: Double?
  let resetCreditsAvailable: Int
  let resetCreditsApplicable: Int?
  let observedAt: Date
}

struct CodexWidgetState: Codable, Equatable, Sendable {
  let updatedAt: Date
  let connectedCount: Int
  let selectedHostID: String?
  let activeAgent: CodexWidgetAgent?
  let agents: [CodexWidgetAgent]
  let usage: CodexWidgetUsage?

  static let empty = CodexWidgetState(
    updatedAt: .distantPast,
    connectedCount: 0,
    selectedHostID: nil,
    activeAgent: nil,
    agents: [],
    usage: nil)

  static let preview = CodexWidgetState(
    updatedAt: .now,
    connectedCount: 2,
    selectedHostID: "preview-mac",
    activeAgent: CodexWidgetAgent(
      id: "preview-0",
      title: "Build iPhone widgets",
      status: "working",
      hostName: "MacBook Air",
      hostLabel: "M",
      activityAt: .now,
      selected: true,
      contextUsedPercent: 58),
    agents: [
      CodexWidgetAgent(
        id: "preview-0", title: "Build iPhone widgets", status: "working",
        hostName: "MacBook Air", hostLabel: "M", activityAt: .now, selected: true,
        contextUsedPercent: 58),
      CodexWidgetAgent(
        id: "preview-1", title: "Polish Stream Deck keys", status: "awaiting-approval",
        hostName: "Windows PC", hostLabel: "W", activityAt: .now.addingTimeInterval(-80),
        selected: false, contextUsedPercent: 84),
      CodexWidgetAgent(
        id: "preview-2", title: "Review relay protocol", status: "idle",
        hostName: "MacBook Air", hostLabel: "M", activityAt: .now.addingTimeInterval(-420),
        selected: false),
      CodexWidgetAgent(
        id: "preview-3", title: "Prepare release", status: "unread",
        hostName: "Windows PC", hostLabel: "W", activityAt: .now.addingTimeInterval(-780),
        selected: false),
      CodexWidgetAgent(
        id: "preview-4", title: "Test native controls", status: "awaiting-response",
        hostName: "MacBook Air", hostLabel: "M", activityAt: .now.addingTimeInterval(-1_020),
        selected: false),
      CodexWidgetAgent(
        id: "preview-5", title: "Package the iOS build", status: "completed",
        hostName: "Windows PC", hostLabel: "W", activityAt: .now.addingTimeInterval(-1_260),
        selected: false),
    ],
    usage: CodexWidgetUsage(
      fiveHourRemaining: 72,
      weeklyRemaining: 56,
      resetCreditsAvailable: 1,
      resetCreditsApplicable: 0,
      observedAt: .now))
}

enum CodexWidgetStateStore {
  static let suiteName = Bundle.main.object(forInfoDictionaryKey: "CodexDeckAppGroup") as? String
    ?? "group.com.example.codexdeck"
  private static let stateKey = "codex-widget-state-v1"

  static func load() -> CodexWidgetState {
    guard let defaults = UserDefaults(suiteName: suiteName),
      let data = defaults.data(forKey: stateKey),
      let state = try? JSONDecoder().decode(CodexWidgetState.self, from: data)
    else { return .empty }
    return state
  }

  static func save(_ state: CodexWidgetState) {
    let previous = load()
    guard state != previous, let defaults = UserDefaults(suiteName: suiteName) else { return }
    let displayChanged = !displayEquivalent(previous, state)
    if !displayChanged && state.updatedAt.timeIntervalSince(previous.updatedAt) < 30 { return }
    guard let data = try? JSONEncoder().encode(state) else { return }
    defaults.set(data, forKey: stateKey)
    if displayChanged { WidgetCenter.shared.reloadAllTimelines() }
  }

  private static func displayEquivalent(_ left: CodexWidgetState, _ right: CodexWidgetState)
    -> Bool
  {
    left.connectedCount == right.connectedCount
      && left.selectedHostID == right.selectedHostID
      && displayAgent(left.activeAgent) == displayAgent(right.activeAgent)
      && left.agents.map(displayAgent) == right.agents.map(displayAgent)
      && displayUsage(left.usage) == displayUsage(right.usage)
  }

  private static func displayAgent(_ agent: CodexWidgetAgent?) -> [String]? {
    guard let agent else { return nil }
    return [
      agent.id, agent.title, agent.status, agent.hostName, agent.hostLabel,
      agent.selected ? "1" : "0", agent.contextUsedPercent.map { String($0) } ?? "",
      agent.isHostConnected ? "1" : "0",
    ]
  }

  private static func displayUsage(_ usage: CodexWidgetUsage?) -> [String]? {
    guard let usage else { return nil }
    return [
      usage.fiveHourRemaining.map { String($0) } ?? "",
      usage.weeklyRemaining.map { String($0) } ?? "",
      String(usage.resetCreditsAvailable), usage.resetCreditsApplicable.map { String($0) } ?? "",
    ]
  }
}
