import AppIntents
import SwiftUI
import UIKit
import WidgetKit

private enum CodexWidgetPalette {
  static let ink = adaptive(
    light: UIColor(red: 0.07, green: 0.08, blue: 0.09, alpha: 1),
    dark: UIColor(red: 0.94, green: 0.95, blue: 0.97, alpha: 1))
  static let secondary = adaptive(
    light: UIColor(red: 0.40, green: 0.43, blue: 0.47, alpha: 1),
    dark: UIColor(red: 0.64, green: 0.68, blue: 0.74, alpha: 1))
  static let panel = adaptive(
    light: UIColor(red: 0.89, green: 0.91, blue: 0.93, alpha: 1),
    dark: UIColor(red: 0.16, green: 0.18, blue: 0.22, alpha: 1))
  static let green = Color(red: 0.18, green: 0.83, blue: 0.44)
  static let blue = Color(red: 0.13, green: 0.53, blue: 0.98)
  static let orange = Color(red: 1.0, green: 0.61, blue: 0.13)
  static let red = Color(red: 1.0, green: 0.27, blue: 0.36)

  private static func adaptive(light: UIColor, dark: UIColor) -> Color {
    Color(uiColor: UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
  }

  static func status(_ value: String) -> Color {
    if ["working", "thinking"].contains(value) { return blue }
    if ["approval", "awaiting-approval", "awaiting-response"].contains(value) { return orange }
    if ["unread", "complete", "completed", "done"].contains(value) { return green }
    if value == "error" { return red }
    return secondary.opacity(0.55)
  }

  static func capacity(_ value: Double?) -> Color {
    guard let value else { return secondary }
    return value < 20 ? red : value < 40 ? orange : green
  }
}

private struct CodexStateEntry: TimelineEntry {
  let date: Date
  let state: CodexWidgetState
}

private struct CodexStateProvider: TimelineProvider {
  func placeholder(in context: Context) -> CodexStateEntry {
    CodexStateEntry(date: .now, state: .preview)
  }

  func getSnapshot(in context: Context, completion: @escaping (CodexStateEntry) -> Void) {
    completion(CodexStateEntry(date: .now, state: context.isPreview ? .preview : CodexWidgetStateStore.load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CodexStateEntry>) -> Void) {
    let entry = CodexStateEntry(date: .now, state: CodexWidgetStateStore.load())
    completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
  }
}

private struct CommandEntry<Configuration: WidgetConfigurationIntent>: TimelineEntry {
  let date: Date
  let state: CodexWidgetState
  let configuration: Configuration
}

private struct SingleCommandProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> CommandEntry<SingleCommandWidgetConfiguration> {
    CommandEntry(date: .now, state: .preview, configuration: SingleCommandWidgetConfiguration())
  }

  func snapshot(
    for configuration: SingleCommandWidgetConfiguration,
    in context: Context
  ) async -> CommandEntry<SingleCommandWidgetConfiguration> {
    CommandEntry(
      date: .now,
      state: context.isPreview ? .preview : CodexWidgetStateStore.load(),
      configuration: configuration)
  }

  func timeline(
    for configuration: SingleCommandWidgetConfiguration,
    in context: Context
  ) async -> Timeline<CommandEntry<SingleCommandWidgetConfiguration>> {
    let entry = CommandEntry(
      date: .now, state: CodexWidgetStateStore.load(), configuration: configuration)
    return Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60)))
  }
}

private struct CommandDeckProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> CommandEntry<CommandDeckWidgetConfiguration> {
    CommandEntry(date: .now, state: .preview, configuration: CommandDeckWidgetConfiguration())
  }

  func snapshot(
    for configuration: CommandDeckWidgetConfiguration,
    in context: Context
  ) async -> CommandEntry<CommandDeckWidgetConfiguration> {
    CommandEntry(
      date: .now,
      state: context.isPreview ? .preview : CodexWidgetStateStore.load(),
      configuration: configuration)
  }

  func timeline(
    for configuration: CommandDeckWidgetConfiguration,
    in context: Context
  ) async -> Timeline<CommandEntry<CommandDeckWidgetConfiguration>> {
    let entry = CommandEntry(
      date: .now, state: CodexWidgetStateStore.load(), configuration: configuration)
    return Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60)))
  }
}

private struct WidgetSurface<Content: View>: View {
  @Environment(\.colorScheme) private var colorScheme
  @ViewBuilder let content: Content

  var body: some View {
    content
      .foregroundStyle(CodexWidgetPalette.ink)
      .containerBackground(for: .widget) {
        LinearGradient(
          colors: colorScheme == .dark
            ? [Color(red: 0.055, green: 0.065, blue: 0.085), Color(red: 0.09, green: 0.115, blue: 0.14)]
            : [.white, Color(red: 0.92, green: 0.95, blue: 0.97)],
          startPoint: .topLeading,
          endPoint: .bottomTrailing)
      }
  }
}

private struct WidgetHeader: View {
  let title: String
  let connectedCount: Int

  var body: some View {
    HStack(spacing: 6) {
      Text(title.uppercased())
        .font(.system(size: 10, weight: .black, design: .rounded))
        .tracking(1.2)
      Spacer(minLength: 4)
      Circle()
        .fill(connectedCount > 0 ? CodexWidgetPalette.green : CodexWidgetPalette.red)
        .frame(width: 7, height: 7)
      if connectedCount > 1 {
        Text("\(connectedCount)")
          .font(.system(size: 9, weight: .bold, design: .rounded))
          .monospacedDigit()
      }
    }
    .foregroundStyle(CodexWidgetPalette.secondary)
  }
}

private struct EmptyWidgetState: View {
  let message: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: "bolt.horizontal.circle")
        .font(.title2)
      Text(message)
        .font(.caption.weight(.semibold))
        .multilineTextAlignment(.center)
    }
    .foregroundStyle(CodexWidgetPalette.secondary)
  }
}

private struct CapacityWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CodexStateEntry

  var body: some View {
    WidgetSurface {
      switch family {
      case .systemMedium:
        medium
      case .accessoryCircular:
        accessoryCircle
      case .accessoryRectangular:
        accessoryRectangle
      default:
        small
      }
    }
  }

  private var small: some View {
    VStack(spacing: 10) {
      WidgetHeader(title: "Capacity", connectedCount: entry.state.connectedCount)
      if let usage = entry.state.usage {
        ZStack {
          Circle().stroke(CodexWidgetPalette.panel, lineWidth: 10)
          Circle()
            .trim(from: 0, to: max(0, min((usage.weeklyRemaining ?? 0) / 100, 1)))
            .stroke(
              CodexWidgetPalette.capacity(usage.weeklyRemaining),
              style: StrokeStyle(lineWidth: 10, lineCap: .round))
            .rotationEffect(.degrees(-90))
            .widgetAccentable()
          VStack(spacing: 1) {
            Text(percent(usage.weeklyRemaining))
              .font(.system(size: 29, weight: .black, design: .rounded))
              .monospacedDigit()
            Text("WEEKLY")
              .font(.system(size: 8, weight: .black, design: .rounded))
              .tracking(1)
          }
        }
        HStack {
          Image(systemName: "arrow.counterclockwise")
          Text("\(usage.resetCreditsAvailable) reset\(usage.resetCreditsAvailable == 1 ? "" : "s")")
          Spacer()
          Text(usage.observedAt, style: .relative)
        }
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(CodexWidgetPalette.secondary)
      } else {
        EmptyWidgetState(message: "Open Codex Deck to load usage")
      }
    }
    .padding(15)
  }

  private var medium: some View {
    VStack(spacing: 14) {
      WidgetHeader(title: "Account capacity", connectedCount: entry.state.connectedCount)
      if let usage = entry.state.usage {
        HStack(spacing: 18) {
          ZStack {
            Circle().stroke(CodexWidgetPalette.panel, lineWidth: 11)
            Circle()
              .trim(from: 0, to: max(0, min((usage.weeklyRemaining ?? 0) / 100, 1)))
              .stroke(
                CodexWidgetPalette.capacity(usage.weeklyRemaining),
                style: StrokeStyle(lineWidth: 11, lineCap: .round))
              .rotationEffect(.degrees(-90))
              .widgetAccentable()
            Text(percent(usage.weeklyRemaining))
              .font(.system(size: 31, weight: .black, design: .rounded))
              .monospacedDigit()
          }
          .frame(width: 94, height: 94)
          VStack(spacing: 13) {
            CapacityBar(title: "5 HOUR", value: usage.fiveHourRemaining, tint: CodexWidgetPalette.blue)
            CapacityBar(
              title: "WEEKLY", value: usage.weeklyRemaining,
              tint: CodexWidgetPalette.capacity(usage.weeklyRemaining))
            HStack {
              Button(
                intent: RunCodexWidgetCommandIntent(
                  command: .rateLimitReset, target: .selected)
              ) {
                Label(
                  "\(usage.resetCreditsAvailable) resets",
                  systemImage: "arrow.counterclockwise")
              }
              .buttonStyle(.plain)
              .disabled(
                usage.resetCreditsAvailable <= 0 || usage.resetCreditsApplicable == 0)
              Spacer()
              Text(usage.observedAt, style: .relative)
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(CodexWidgetPalette.secondary)
          }
        }
      } else {
        EmptyWidgetState(message: "Open Codex Deck to load account capacity")
      }
    }
    .padding(16)
  }

  private var accessoryCircle: some View {
    ZStack {
      AccessoryWidgetBackground()
      Gauge(value: entry.state.usage?.weeklyRemaining ?? 0, in: 0...100) {
        Text("Weekly")
      } currentValueLabel: {
        Text(percent(entry.state.usage?.weeklyRemaining))
          .font(.caption2.bold())
      }
      .gaugeStyle(.accessoryCircularCapacity)
    }
  }

  private var accessoryRectangle: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("CODEX CAPACITY").font(.caption2.bold())
      HStack {
        Text("5h")
        Text(percent(entry.state.usage?.fiveHourRemaining)).bold()
        Spacer()
        Text("Week")
        Text(percent(entry.state.usage?.weeklyRemaining)).bold()
      }
      .font(.caption2)
    }
  }

  private func percent(_ value: Double?) -> String {
    value.map { "\(Int($0.rounded()))%" } ?? "—"
  }
}

private struct CapacityBar: View {
  let title: String
  let value: Double?
  let tint: Color

  var body: some View {
    VStack(spacing: 5) {
      HStack {
        Text(title).font(.system(size: 9, weight: .black, design: .rounded)).tracking(1)
        Spacer()
        Text(value.map { "\(Int($0.rounded()))%" } ?? "—")
          .font(.system(size: 11, weight: .bold, design: .rounded))
          .monospacedDigit()
      }
      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule().fill(CodexWidgetPalette.panel)
          if let value {
            Capsule().fill(tint)
              .frame(width: proxy.size.width * max(0, min(value / 100, 1)))
              .widgetAccentable()
          }
        }
      }
      .frame(height: 7)
    }
  }
}

private struct CurrentAgentWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CodexStateEntry

  var body: some View {
    WidgetSurface {
      VStack(alignment: .leading, spacing: family == .systemMedium ? 13 : 9) {
        WidgetHeader(title: "Current agent", connectedCount: entry.state.connectedCount)
        if let agent = entry.state.activeAgent {
          HStack(alignment: .top, spacing: 12) {
            WidgetAgentStatusOrb(
              agent: agent, size: family == .systemMedium ? 52 : 40)
            VStack(alignment: .leading, spacing: 4) {
              Text(agent.title)
                .font(family == .systemMedium ? .headline : .subheadline.weight(.bold))
                .lineLimit(family == .systemMedium ? 2 : 3)
                .privacySensitive()
              HStack(spacing: 5) {
                Text(agent.hostLabel)
                  .font(.system(size: 8, weight: .black))
                  .foregroundStyle(.white)
                  .frame(width: 19, height: 19)
                  .background(CodexWidgetPalette.ink, in: Circle())
                Text(agent.hostName).lineLimit(1)
                Text("·")
                Text(agent.activityAt, style: .relative)
              }
              .font(.caption2)
              .foregroundStyle(CodexWidgetPalette.secondary)
            }
          }
          if family == .systemMedium {
            HStack {
              Label(
                agent.isHostConnected
                  ? agent.status.replacingOccurrences(of: "-", with: " ") : "offline",
                systemImage: agent.isHostConnected ? "waveform.path" : "wifi.slash")
              Spacer()
              if agent.selected { Label("Selected", systemImage: "viewfinder") }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(CodexWidgetPalette.status(displayStatus(agent)))
          }
        } else {
          EmptyWidgetState(message: "No active agent yet")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .padding(16)
    }
  }
}

private struct AgentBoardWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CodexStateEntry

  var body: some View {
    WidgetSurface {
      VStack(spacing: 11) {
        WidgetHeader(title: "Agent board", connectedCount: entry.state.connectedCount)
        if entry.state.agents.isEmpty {
          EmptyWidgetState(message: "No recent agents")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          let columns = family == .systemLarge
            ? [GridItem(.flexible()), GridItem(.flexible())]
            : [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]
          LazyVGrid(columns: columns, spacing: 8) {
            ForEach(Array(entry.state.agents.prefix(family == .systemLarge ? 6 : 3))) { agent in
              AgentTile(agent: agent, compact: family != .systemLarge)
            }
          }
        }
      }
      .padding(15)
    }
  }
}

private struct AgentTile: View {
  let agent: CodexWidgetAgent
  let compact: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        WidgetContextIndicator(agent: agent)
        Spacer()
        Text(agent.hostLabel).font(.system(size: 8, weight: .black))
      }
      Text(agent.title)
        .font(.system(size: compact ? 10 : 12, weight: .semibold, design: .rounded))
        .lineLimit(compact ? 3 : 2)
        .privacySensitive()
      Spacer(minLength: 0)
      if agent.isHostConnected {
        Text(agent.activityAt, style: .relative)
          .font(.system(size: 8, weight: .medium))
          .foregroundStyle(CodexWidgetPalette.secondary)
      } else {
        Label("Offline", systemImage: "wifi.slash")
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(CodexWidgetPalette.secondary)
      }
    }
    .padding(compact ? 9 : 11)
    .frame(maxWidth: .infinity, minHeight: compact ? 82 : 94, alignment: .topLeading)
    .background(
      CodexWidgetPalette.status(displayStatus(agent)).opacity(agent.selected ? 0.18 : 0.08),
      in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 15, style: .continuous)
        .stroke(CodexWidgetPalette.status(displayStatus(agent)).opacity(agent.selected ? 0.7 : 0.18))
    }
  }
}

private struct WidgetAgentStatusOrb: View {
  let agent: CodexWidgetAgent
  let size: CGFloat

  var body: some View {
    ZStack {
      Circle().fill(CodexWidgetPalette.status(displayStatus(agent)).opacity(0.13))
      Circle().stroke(CodexWidgetPalette.panel, lineWidth: 3)
      if let context = agent.contextUsedPercent {
        Circle()
          .trim(from: 0, to: max(0, min(context / 100, 1)))
          .stroke(contextColor(context), style: StrokeStyle(lineWidth: 3, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
      Image(systemName: agent.isHostConnected ? statusSymbol(agent.status) : "wifi.slash")
        .font(.system(size: size * 0.34, weight: .bold))
        .foregroundStyle(CodexWidgetPalette.status(displayStatus(agent)))
    }
    .frame(width: size, height: size)
    .widgetAccentable()
  }
}

private struct WidgetContextIndicator: View {
  let agent: CodexWidgetAgent

  var body: some View {
    ZStack {
      Circle().stroke(CodexWidgetPalette.panel, lineWidth: 1.5)
      if let context = agent.contextUsedPercent {
        Circle()
          .trim(from: 0, to: max(0, min(context / 100, 1)))
          .stroke(contextColor(context), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
      Circle().fill(CodexWidgetPalette.status(displayStatus(agent))).frame(width: 3, height: 3)
    }
    .frame(width: 10, height: 10)
    .widgetAccentable()
  }
}

private func contextColor(_ percent: Double) -> Color {
  if percent >= 92 { return CodexWidgetPalette.red }
  if percent >= 80 { return CodexWidgetPalette.orange }
  return CodexWidgetPalette.blue
}

private struct SingleCommandWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CommandEntry<SingleCommandWidgetConfiguration>

  var body: some View {
    let command = entry.configuration.command
    WidgetSurface {
      Button(intent: RunCodexWidgetCommandIntent(command: command, target: entry.configuration.target)) {
        if family == .accessoryCircular {
          Image(systemName: command.symbol)
            .font(.title3.bold())
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          VStack(spacing: 10) {
            WidgetHeader(title: "Command", connectedCount: entry.state.connectedCount)
            Spacer(minLength: 0)
            Image(systemName: command.symbol)
              .font(.system(size: 38, weight: .semibold))
            Text(command.name)
              .font(.subheadline.weight(.bold))
              .lineLimit(2)
              .multilineTextAlignment(.center)
            Text(entry.configuration.target == .selected ? "SELECTED HOST" : entry.configuration.target.rawValue.uppercased())
              .font(.system(size: 8, weight: .black, design: .rounded))
              .tracking(1)
              .foregroundStyle(CodexWidgetPalette.secondary)
            Spacer(minLength: 0)
          }
          .padding(15)
        }
      }
      .buttonStyle(.plain)
    }
  }
}

private struct CommandDeckWidgetView: View {
  let entry: CommandEntry<CommandDeckWidgetConfiguration>

  var body: some View {
    WidgetSurface {
      VStack(spacing: 8) {
        WidgetHeader(title: "Control deck", connectedCount: entry.state.connectedCount)
        LazyVGrid(
          columns: [GridItem(.flexible(), spacing: 7), GridItem(.flexible())], spacing: 7
        ) {
          ForEach(entry.configuration.commands, id: \.rawValue) { command in
            Button(
              intent: RunCodexWidgetCommandIntent(
                command: command, target: entry.configuration.target)
            ) {
              HStack(spacing: 7) {
                Image(systemName: command.symbol)
                  .font(.system(size: 15, weight: .semibold))
                  .frame(width: 21)
                Text(command.name)
                  .font(.system(size: 9.5, weight: .bold, design: .rounded))
                  .lineLimit(2)
                  .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
              }
              .foregroundStyle(CodexWidgetPalette.ink)
              .padding(8)
              .frame(maxWidth: .infinity, minHeight: 46)
              .background(
                CodexWidgetPalette.panel.opacity(0.72), in: RoundedRectangle(cornerRadius: 13))
              .overlay {
                RoundedRectangle(cornerRadius: 13)
                  .stroke(CodexWidgetPalette.ink.opacity(0.08))
              }
            }
            .buttonStyle(.plain)
          }
        }
        HStack {
          Text(entry.configuration.target == .selected ? "Selected computer" : entry.configuration.target.rawValue.capitalized)
          Spacer()
          Text("Hold widget to configure")
        }
        .font(.system(size: 7.5, weight: .semibold))
        .foregroundStyle(CodexWidgetPalette.secondary)
      }
      .padding(13)
    }
  }
}

private func statusSymbol(_ status: String) -> String {
  if ["working", "thinking"].contains(status) { return "waveform.path.ecg" }
  if ["approval", "awaiting-approval", "awaiting-response"].contains(status) {
    return "exclamationmark.circle.fill"
  }
  if ["unread", "complete", "completed", "done"].contains(status) {
    return "checkmark.circle.fill"
  }
  if status == "error" { return "xmark.octagon.fill" }
  return "circle.fill"
}

private func displayStatus(_ agent: CodexWidgetAgent) -> String {
  agent.isHostConnected ? agent.status : "offline"
}

struct CodexCapacityWidget: Widget {
  let kind = "com.simeo.codexdeck.capacity"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CodexStateProvider()) { entry in
      CapacityWidgetView(entry: entry)
    }
    .configurationDisplayName("Codex Capacity")
    .description("See five-hour and weekly limits plus available resets.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    .contentMarginsDisabled()
  }
}

struct CodexCurrentAgentWidget: Widget {
  let kind = "com.simeo.codexdeck.current-agent"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CodexStateProvider()) { entry in
      CurrentAgentWidgetView(entry: entry)
    }
    .configurationDisplayName("Current Codex Agent")
    .description("See the current or most recently active Codex agent.")
    .supportedFamilies([.systemSmall, .systemMedium])
    .contentMarginsDisabled()
  }
}

struct CodexAgentBoardWidget: Widget {
  let kind = "com.simeo.codexdeck.agent-board"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CodexStateProvider()) { entry in
      AgentBoardWidgetView(entry: entry)
    }
    .configurationDisplayName("Codex Agent Board")
    .description("Track three or six recent agents across Mac and Windows.")
    .supportedFamilies([.systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

struct CodexSingleCommandWidget: Widget {
  let kind = "com.simeo.codexdeck.single-command"

  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: kind,
      intent: SingleCommandWidgetConfiguration.self,
      provider: SingleCommandProvider()
    ) { entry in
      SingleCommandWidgetView(entry: entry)
    }
    .configurationDisplayName("Codex Command")
    .description("Put one configurable Codex Micro command on your Home or Lock Screen.")
    .supportedFamilies([.systemSmall, .accessoryCircular])
    .contentMarginsDisabled()
  }
}

struct CodexCommandDeckWidget: Widget {
  let kind = "com.simeo.codexdeck.command-deck"

  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: kind,
      intent: CommandDeckWidgetConfiguration.self,
      provider: CommandDeckProvider()
    ) { entry in
      CommandDeckWidgetView(entry: entry)
    }
    .configurationDisplayName("Codex Control Deck")
    .description("Choose four Codex commands and one target computer.")
    .supportedFamilies([.systemMedium])
    .contentMarginsDisabled()
  }
}

@main
struct CodexDeckWidgetsBundle: WidgetBundle {
  var body: some Widget {
    CodexCapacityWidget()
    CodexCurrentAgentWidget()
    CodexAgentBoardWidget()
    CodexSingleCommandWidget()
    CodexCommandDeckWidget()
    CodexAgentLiveActivity()
  }
}
