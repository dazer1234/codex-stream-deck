import SwiftUI

struct DashboardView: View {
  @Environment(DashboardStore.self) private var store
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var resetConfirmation = false
  @State private var showingAllKeys = false
  @State private var editingKeySlot: DeviceKeySlot?

  var body: some View {
    @Bindable var store = store
    let agents = store.agents
    let hasAttention = agents.contains(where: \.isAttention)
    ZStack(alignment: .bottom) {
      CodexBackdrop(accent: hasAttention ? CodexTheme.orange : CodexTheme.blue)
        .ignoresSafeArea()
      ScrollView {
        LazyVStack(spacing: 22) {
          HeaderView { showingAllKeys = true }
          if store.profiles.isEmpty {
            PairingWelcome()
          } else {
            dashboardContent(compactHeight: verticalSizeClass == .compact)
          }
          Color.clear.frame(height: 16)
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
      }
      .scrollIndicators(.hidden)
      .defaultScrollAnchor(.top)

      if let receipt = store.visibleCommandReceipt {
        CommandReceiptHUD(receipt: receipt)
          .padding(.horizontal, 18)
          .padding(.bottom, 12)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      } else if let toast = store.toast {
        Text(toast.message)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 16)
          .padding(.vertical, 11)
          .background(toast.kind == .success ? CodexTheme.control : CodexTheme.red, in: Capsule())
          .shadow(radius: 12, y: 6)
          .padding(.bottom, 12)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .tint(CodexTheme.ink)
    .sheet(isPresented: $store.showingSettings) { SettingsView() }
    .sheet(isPresented: $store.showingAttentionCenter) { AttentionCenterView() }
    .sheet(isPresented: $showingAllKeys) { AllKeysView() }
    .sheet(item: $editingKeySlot) { KeycapPickerView(slot: $0) }
    .sheet(item: $store.presentedAgentReference) { reference in
      AgentDetailView(reference: reference)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(.clear)
    }
    .confirmationDialog(
      "Use one rate-limit reset?", isPresented: $resetConfirmation, titleVisibility: .visible
    ) {
      Button("Use reset", role: .destructive) { Task { await store.resetRateLimit() } }
    } message: {
      Text("This sends the same authenticated reset command as the Stream Deck button.")
    }
    .animation(.snappy, value: store.toast)
    .animation(.snappy, value: store.visibleCommandReceipt)
    .sensoryFeedback(.impact(weight: .medium), trigger: store.presentedAgentReference?.threadIdentity)
    .sensoryFeedback(.success, trigger: store.commandSuccessPulse)
    .sensoryFeedback(.error, trigger: store.commandErrorPulse)
  }

  @ViewBuilder
  private func dashboardContent(compactHeight: Bool) -> some View {
    if compactHeight {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 18) {
          microDevice
            .frame(width: 325)
          VStack(spacing: 18) {
            ActiveChatsView()
            UsageHero(resetConfirmation: $resetConfirmation)
          }
          .frame(width: 315)
        }
        .frame(maxWidth: .infinity, alignment: .top)

        VStack(spacing: 18) {
          microDevice
            .frame(maxWidth: 360)
          ActiveChatsView()
          UsageHero(resetConfirmation: $resetConfirmation)
        }
        .frame(maxWidth: .infinity)
      }
    } else {
      microDevice
      ActiveChatsView()
      UsageHero(resetConfirmation: $resetConfirmation)
    }
  }

  private var microDevice: some View {
    CodexMicroDeviceView(
      placements: store.mobileAgentPlacements,
      editKey: { editingKeySlot = $0 },
      showAgent: { store.presentAgent($0) })
  }
}

private struct CommandReceiptHUD: View {
  let receipt: CommandReceipt

  var body: some View {
    HStack(spacing: 12) {
      statusIcon
        .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(receipt.title)
          .font(.subheadline.weight(.bold))
          .lineLimit(1)
        Text(receipt.detail)
          .font(.caption)
          .foregroundStyle(CodexTheme.secondary)
          .lineLimit(2)
      }
      Spacer(minLength: 6)
      Text(receipt.hostPlatform.shortLabel)
        .font(.caption2.weight(.black))
        .foregroundStyle(.white)
        .frame(width: 25, height: 25)
        .background(tint, in: Circle())
    }
    .padding(.horizontal, 15)
    .padding(.vertical, 12)
    .codexGlassSurface(cornerRadius: 21, tint: tint.opacity(0.1), interactive: false)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(receipt.title), \(receipt.detail)")
  }

  @ViewBuilder
  private var statusIcon: some View {
    switch receipt.stage {
    case .sending:
      ProgressView().tint(tint)
    case .hostConfirmed:
      Image(systemName: "arrow.up.circle.fill")
        .font(.title3).foregroundStyle(tint)
    case .stateConfirmed:
      Image(systemName: "checkmark.circle.fill")
        .font(.title3).foregroundStyle(tint)
    case .warning:
      Image(systemName: "exclamationmark.circle.fill")
        .font(.title3).foregroundStyle(tint)
    case .failed:
      Image(systemName: "xmark.circle.fill")
        .font(.title3).foregroundStyle(tint)
    }
  }

  private var tint: Color {
    switch receipt.stage {
    case .sending, .hostConfirmed: CodexTheme.blue
    case .stateConfirmed: CodexTheme.green
    case .warning: CodexTheme.orange
    case .failed: CodexTheme.red
    }
  }
}

private struct HeaderView: View {
  @Environment(DashboardStore.self) private var store
  let showAllKeys: () -> Void

  var body: some View {
    HStack(spacing: 7) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("CODEX")
          .font(.system(size: 28, weight: .black, design: .rounded))
          .tracking(1.5)
          .lineLimit(1)
        Text("MICRO")
          .font(.caption.weight(.bold))
          .tracking(3)
          .foregroundStyle(CodexTheme.secondary)
          .lineLimit(1)
      }
      .fixedSize(horizontal: true, vertical: false)
      Spacer()
      ConnectionLight()
      HeaderHostMenu()
      if #available(iOS 26.0, *) {
        GlassEffectContainer(spacing: 8) {
          HeaderGlassActions(showAllKeys: showAllKeys)
        }
        .overlay(alignment: .topLeading) { AttentionBadge() }
      } else {
        HeaderGlassActions(showAllKeys: showAllKeys)
          .overlay(alignment: .topLeading) { AttentionBadge() }
      }
    }
    .foregroundStyle(CodexTheme.ink)
  }
}

private struct HeaderGlassActions: View {
  @Environment(DashboardStore.self) private var store
  let showAllKeys: () -> Void

  var body: some View {
    HStack(spacing: 7) {
      Button {
        store.showingAttentionCenter = true
      } label: {
        Image(systemName: store.unreadAttentionCount > 0 ? "bell.fill" : "bell")
          .font(.system(size: 15, weight: .semibold))
          .frame(width: 36, height: 36)
          .codexGlassSurface(
            cornerRadius: 18,
            tint: store.unreadAttentionCount > 0 ? CodexTheme.orange.opacity(0.12) : nil,
            interactive: true)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(
        store.unreadAttentionCount == 0
          ? "Attention center" : "Attention center, \(store.unreadAttentionCount) unread")
      Button(action: showAllKeys) {
        Image(systemName: "square.grid.3x3.fill")
          .font(.system(size: 15, weight: .semibold))
          .frame(width: 36, height: 36)
          .codexGlassSurface(cornerRadius: 18, interactive: true)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("All Codex keys")
      Button {
        store.showingSettings = true
      } label: {
        Image(systemName: "gearshape.fill")
          .font(.system(size: 16, weight: .semibold))
          .frame(width: 36, height: 36)
          .codexGlassSurface(cornerRadius: 18, interactive: true)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Connection settings")
    }
  }
}

private struct AttentionBadge: View {
  @Environment(DashboardStore.self) private var store

  var body: some View {
    if store.unreadAttentionCount > 0 {
      Text(store.unreadAttentionCount > 9 ? "9+" : "\(store.unreadAttentionCount)")
        .font(.system(size: 8, weight: .black, design: .rounded))
        .foregroundStyle(.white)
        .padding(.horizontal, 4)
        .frame(minWidth: 15, minHeight: 15)
        .background(CodexTheme.red, in: Capsule())
        .offset(x: 25, y: -3)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .zIndex(100)
    }
  }
}

private struct ConnectionLight: View {
  @Environment(DashboardStore.self) private var store

  var body: some View {
    let ready = store.connectedCount
    Circle()
      .fill(
        ready == store.expectedCount && ready > 0
          ? CodexTheme.green : ready > 0 ? CodexTheme.orange : CodexTheme.red
      )
      .frame(width: 11, height: 11)
      .shadow(color: CodexTheme.green.opacity(ready > 0 ? 0.35 : 0), radius: 5)
      .accessibilityLabel("\(ready) of \(store.expectedCount) computers connected")
  }
}

private struct HeaderHostMenu: View {
  @Environment(DashboardStore.self) private var store

  var body: some View {
    let hosts = Dictionary(grouping: store.nodes.values.compactMap(\.host), by: \.hostId)
      .compactMap { $0.value.first }
      .sorted { $0.platform.rawValue < $1.platform.rawValue }
    Menu {
      ForEach(hosts, id: \.hostId) { host in
        Button {
          store.selectHost(host)
        } label: {
          Label(
            host.hostName,
            systemImage: store.selectedHost?.hostId == host.hostId ? "checkmark.circle.fill" : "circle")
        }
      }
    } label: {
      Text(store.selectedHost?.platform.shortLabel ?? "–")
        .font(.caption2.weight(.black))
        .foregroundStyle(.white)
        .frame(width: 30, height: 30)
        .background(CodexTheme.control, in: Circle())
    }
    .accessibilityLabel("Control computer")
  }
}

private struct PairingWelcome: View {
  @Environment(DashboardStore.self) private var store

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "iphone.and.arrow.forward")
        .font(.system(size: 44, weight: .light))
      Text("Bring Codex Micro with you")
        .font(.title2.bold())
      Text(
        "Pair your Mac or Windows computer over nearby Wi-Fi, then add Tailscale when you want secure access away from home. Chrome DevTools never leaves the computer."
      )
      .font(.subheadline)
      .foregroundStyle(CodexTheme.secondary)
      .multilineTextAlignment(.center)
      .lineSpacing(3)
      Button("Pair first computer") { store.showingSettings = true }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }
    .padding(28)
    .frame(maxWidth: .infinity)
    .codexGlassSurface(cornerRadius: 30, tint: .white.opacity(0.08))
  }
}

private struct UsageHero: View {
  @Environment(DashboardStore.self) private var store
  @Binding var resetConfirmation: Bool

  var body: some View {
    let usage = store.usageSource?.snapshot.usage
    let fiveHour = usage?.windows.first(where: { $0.kind == "five-hour" })
    let weekly = usage?.windows.first(where: { $0.kind == "weekly" })
    VStack(spacing: 16) {
      SectionLabel("Account capacity", detail: freshness(usage?.observedAt))
      HStack(spacing: 20) {
        UsageRing(value: weekly?.remainingPercent, title: "WEEKLY")
        VStack(spacing: 13) {
          UsageBar(title: "5 HOUR", value: fiveHour?.remainingPercent, tint: CodexTheme.blue)
          UsageBar(
            title: "WEEKLY", value: weekly?.remainingPercent,
            tint: capacityColor(weekly?.remainingPercent))
          HStack {
            Label(
              "\(usage?.resetCreditsAvailable ?? 0) resets", systemImage: "arrow.counterclockwise"
            )
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            Spacer()
            Button("Use") { resetConfirmation = true }
              .font(.caption.bold())
              .disabled(
                (usage?.resetCreditsAvailable ?? 0) <= 0 || usage?.resetCreditsApplicable == 0)
          }
        }
      }
    }
    .padding(20)
    .codexGlassSurface(cornerRadius: 28, tint: .white.opacity(0.08))
  }

  private func freshness(_ timestamp: Double?) -> String? {
    guard let timestamp else { return "Waiting for usage" }
    return Date(timeIntervalSince1970: timestamp / 1000).formatted(
      .relative(presentation: .numeric))
  }

  private func capacityColor(_ value: Double?) -> Color {
    guard let value else { return CodexTheme.secondary }
    return value < 20 ? CodexTheme.red : value < 40 ? CodexTheme.orange : CodexTheme.green
  }
}

private struct UsageRing: View {
  let value: Double?
  let title: String

  var body: some View {
    let fraction = min(max((value ?? 0) / 100, 0), 1)
    ZStack {
      Circle().stroke(CodexTheme.panel, lineWidth: 11)
      Circle()
        .trim(from: 0, to: fraction)
        .stroke(
          value.map { $0 < 20 ? CodexTheme.red : CodexTheme.green } ?? CodexTheme.secondary,
          style: StrokeStyle(lineWidth: 11, lineCap: .round)
        )
        .rotationEffect(.degrees(-90))
      VStack(spacing: 1) {
        Text(value.map { "\(Int($0.rounded()))" } ?? "–")
          .font(.system(size: 34, weight: .bold, design: .rounded))
          .monospacedDigit()
        Text(title).font(.system(size: 8, weight: .bold)).tracking(1)
      }
    }
    .frame(width: 112, height: 112)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(title) remaining")
    .accessibilityValue(value.map { "\(Int($0.rounded())) percent" } ?? "Unavailable")
  }
}

private struct UsageBar: View {
  let title: String
  let value: Double?
  let tint: Color

  var body: some View {
    VStack(spacing: 5) {
      HStack {
        Text(title).font(.system(size: 9, weight: .bold)).tracking(1)
        Spacer()
        Text(value.map { "\(Int($0.rounded()))%" } ?? "—")
          .font(.caption.weight(.bold)).monospacedDigit()
      }
      GeometryReader { proxy in
        Capsule().fill(CodexTheme.panel)
          .overlay(alignment: .leading) {
            Capsule().fill(tint).frame(width: proxy.size.width * min(max((value ?? 0) / 100, 0), 1))
          }
      }
      .frame(height: 8)
    }
  }
}

private struct AgentGrid: View {
  @Environment(DashboardStore.self) private var store
  private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

  var body: some View {
    VStack(spacing: 12) {
      SectionLabel("Live agents", detail: "Newest across Mac + Windows")
      LazyVGrid(columns: columns, spacing: 12) {
        ForEach(0..<6, id: \.self) { index in
          if let agent = store.agents.first(where: { $0.id == index }) {
            AgentCard(agent: agent)
          } else {
            EmptyAgentCard(index: index)
          }
        }
      }
    }
  }
}

private struct AgentCard: View {
  @Environment(DashboardStore.self) private var store
  let agent: RoutedAgent

  var body: some View {
    let hostState = store.connectionState(for: agent.host.hostId)
    Button {
      Task { await store.activate(agent) }
    } label: {
      VStack(alignment: .leading, spacing: 13) {
        HStack {
          ZStack {
            Circle().fill(CodexTheme.statusColor(agent.status).opacity(0.15)).frame(
              width: 34, height: 34)
            Image(systemName: statusSymbol).font(.system(size: 15, weight: .bold))
          }
          Spacer()
          Text(agent.originPlatform.shortLabel)
            .font(.caption2.weight(.black))
            .frame(width: 23, height: 23)
            .background(hostState == .ready ? CodexTheme.control : CodexTheme.red, in: Circle())
            .foregroundStyle(.white)
        }
        Text(agent.title)
          .font(.subheadline.weight(.semibold))
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 6) {
          Circle().fill(CodexTheme.statusColor(agent.status)).frame(width: 7, height: 7)
          Text(hostState == .offline ? "OFFLINE" : statusTitle)
            .font(.caption2.weight(.bold)).foregroundStyle(
              hostState == .offline ? CodexTheme.red : CodexTheme.secondary
            )
          Spacer()
          if agent.originPlatform != agent.host.platform {
            Text("VIA \(agent.host.platform.shortLabel)")
              .font(.system(size: 7, weight: .black))
              .foregroundStyle(CodexTheme.secondary)
          }
          if agent.selected { Image(systemName: "viewfinder").font(.caption2) }
        }
      }
      .padding(15)
      .frame(minHeight: 150)
      .background(.white.opacity(0.82), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
      .overlay(alignment: .leading) {
        if agent.isAttention {
          Capsule().fill(CodexTheme.statusColor(agent.status)).frame(width: 4).padding(
            .vertical, 18)
        }
      }
    }
    .buttonStyle(.plain)
    .disabled(hostState == .offline || hostState == .connecting)
    .opacity(hostState == .offline || hostState == .connecting ? 0.68 : 1)
    .accessibilityHint("Opens this task on \(agent.host.hostName)")
  }

  private var statusSymbol: String {
    if ["working", "thinking"].contains(agent.status) { return "sparkles" }
    if ["approval", "awaiting-approval", "awaiting-response"].contains(agent.status) {
      return "hand.raised.fill"
    }
    if agent.status == "error" { return "exclamationmark" }
    if ["unread", "complete", "completed", "done"].contains(agent.status) { return "checkmark" }
    return "circle.fill"
  }

  private var statusTitle: String {
    agent.status.replacingOccurrences(of: "-", with: " ").uppercased()
  }
}

private struct EmptyAgentCard: View {
  let index: Int
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "plus").font(.title3.weight(.semibold))
      Text("SLOT \(index + 1)").font(.caption2.bold()).tracking(1)
    }
    .foregroundStyle(CodexTheme.secondary.opacity(0.6))
    .frame(maxWidth: .infinity, minHeight: 150)
    .background(.white.opacity(0.42), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
  }
}

private struct MicroConsole: View {
  @Environment(DashboardStore.self) private var store

  var body: some View {
    VStack(spacing: 16) {
      HStack {
        SectionLabel("Micro console")
        Spacer()
        HostPicker()
      }
      VStack(spacing: 13) {
        HStack(spacing: 12) {
          ConsoleButton(title: "Fast", symbol: "bolt.fill") { await store.pressAction("ACT06") }
          ConsoleButton(title: "Approve", symbol: "checkmark.circle") {
            await store.pressAction("ACT07")
          }
          ConsoleButton(title: "Decline", symbol: "xmark.circle") {
            await store.pressAction("ACT08")
          }
          ConsoleButton(title: "Fork", symbol: "arrow.triangle.branch") {
            await store.pressAction("ACT09")
          }
        }
        HStack(spacing: 12) {
          ConsoleButton(title: "Back", symbol: "chevron.left") { await store.pressJoystick("left") }
          ConsoleButton(title: "Plan", symbol: "list.bullet.clipboard") {
            await store.pressJoystick("up")
          }
          ConsoleButton(title: "New", symbol: "plus.bubble") {
            await store.trigger(.keycap(id: "NEW"))
          }
          ConsoleButton(title: "Send", symbol: "arrow.up.circle.fill") {
            await store.pressAction("ACT12")
          }
        }
        HStack(spacing: 12) {
          Button {
            Task { await store.trigger(.reasoning(direction: "decrease")) }
          } label: {
            Image(systemName: "minus").font(.title3.bold())
          }.buttonStyle(HardwareKeyStyle())
          VStack(spacing: 3) {
            Image(systemName: "brain.head.profile").font(.title2)
            Text("REASONING").font(.system(size: 8, weight: .bold)).tracking(1)
          }
          .frame(maxWidth: .infinity, minHeight: 62)
          Button {
            Task { await store.trigger(.reasoning(direction: "increase")) }
          } label: {
            Image(systemName: "plus").font(.title3.bold())
          }.buttonStyle(HardwareKeyStyle())
        }
      }
      .padding(16)
      .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 30, style: .continuous).stroke(
          .white.opacity(0.8), lineWidth: 2))
      Text("LET’S BUILD")
        .font(.system(size: 8, weight: .bold)).tracking(2)
        .foregroundStyle(CodexTheme.secondary)
    }
  }
}

private struct ConsoleButton: View {
  let title: String
  let symbol: String
  let action: () async -> Void

  var body: some View {
    Button {
      Task { await action() }
    } label: {
      VStack(spacing: 5) {
        Image(systemName: symbol).font(.system(size: 19, weight: .semibold))
        Text(title.uppercased()).font(.system(size: 7, weight: .bold)).lineLimit(1)
      }
    }
    .buttonStyle(HardwareKeyStyle())
  }
}

private struct HostPicker: View {
  @Environment(DashboardStore.self) private var store
  var body: some View {
    HStack(spacing: 4) {
      ForEach(store.nodes.values.compactMap(\.host).uniqued(), id: \.hostId) { host in
        Button(host.platform.shortLabel) { store.selectHost(host) }
          .font(.caption2.weight(.black))
          .frame(width: 28, height: 28)
          .background(
            store.selectedHost?.hostId == host.hostId ? CodexTheme.control : CodexTheme.key,
            in: Circle()
          )
          .foregroundStyle(store.selectedHost?.hostId == host.hostId ? .white : CodexTheme.ink)
          .accessibilityLabel("Control \(host.platform.displayName)")
      }
    }
  }
}

extension Array where Element == CodexHost {
  fileprivate func uniqued() -> [CodexHost] {
    var seen = Set<String>()
    return filter { seen.insert($0.hostId).inserted }
  }
}

#Preview("Dual host dashboard") {
  DashboardView()
    .environment(DashboardStore(defaults: UserDefaults(suiteName: "preview-dashboard")!))
}
