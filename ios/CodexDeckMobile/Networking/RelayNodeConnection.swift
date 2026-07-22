import Foundation
import CryptoKit
import Security

typealias RelayNodeUpdate = @MainActor (UUID, NodeStatus) -> Void

@MainActor
protocol RelayNodeConnecting: AnyObject {
  func start()
  func stop(publishOffline: Bool)
  func send(_ command: RelayCommand) async throws -> RelayDelivery
  func testConnection() async throws -> RelayConnectionProbe
}

extension RelayNodeConnecting {
  func stop() { stop(publishOffline: true) }
  func testConnection() async throws -> RelayConnectionProbe {
    throw RelayConnectionError.notConnected
  }
}

@MainActor
final class RelayNodeConnection: RelayNodeConnecting {
  private let profile: NodeProfile
  private let token: String
  private let update: RelayNodeUpdate
  private var task: URLSessionWebSocketTask?
  private var session: URLSession?
  private var trustDelegate: PinnedCertificateDelegate?
  private var runTask: Task<Void, Never>?
  private var pending: [String: CheckedContinuation<Void, Error>] = [:]
  private var status = NodeStatus()
  private var stopped = false

  init(profile: NodeProfile, token: String, update: @escaping RelayNodeUpdate) {
    self.profile = profile
    self.token = token
    self.update = update
  }

  func start() {
    guard runTask == nil else { return }
    stopped = false
    runTask = Task { [weak self] in await self?.connectionLoop() }
  }

  func stop(publishOffline: Bool = true) {
    stopped = true
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    session?.invalidateAndCancel()
    session = nil
    trustDelegate = nil
    runTask?.cancel()
    runTask = nil
    failPending(URLError(.cancelled))
    if publishOffline { publish(state: .offline, detail: "Disconnected") }
  }

  func send(_ command: RelayCommand) async throws -> RelayDelivery {
    guard let task, status.state == .ready || status.state == .degraded else {
      throw RelayConnectionError.notConnected
    }
    let requestID = UUID().uuidString
    let startedAt = ContinuousClock.now
    let message = CommandEnvelope(
      type: "command", protocol: 1, requestId: requestID, command: command)
    let data = try JSONEncoder().encode(message)
    guard data.count <= 64 * 1024 else { throw RelayConnectionError.messageTooLarge }
    try await withCheckedThrowingContinuation { continuation in
      pending[requestID] = continuation
      Task {
        do { try await task.send(.data(data)) } catch {
          if let continuation = pending.removeValue(forKey: requestID) {
            continuation.resume(throwing: error)
          }
        }
      }
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(10))
        if let continuation = self?.pending.removeValue(forKey: requestID) {
          continuation.resume(throwing: URLError(.timedOut))
        }
      }
    }
    let elapsed = startedAt.duration(to: .now)
    return RelayDelivery(
      requestID: requestID,
      elapsedMilliseconds: Int(elapsed.components.seconds * 1_000)
        + Int(elapsed.components.attoseconds / 1_000_000_000_000_000))
  }

  func testConnection() async throws -> RelayConnectionProbe {
    guard let task, status.state == .ready || status.state == .degraded else {
      throw RelayConnectionError.notConnected
    }
    let startedAt = ContinuousClock.now
    let pingError: Error? = await withCheckedContinuation { continuation in
      task.sendPing { continuation.resume(returning: $0) }
    }
    if let pingError { throw pingError }
    let elapsed = startedAt.duration(to: .now)
    let probe = RelayConnectionProbe(
      elapsedMilliseconds: Int(elapsed.components.seconds * 1_000)
        + Int(elapsed.components.attoseconds / 1_000_000_000_000_000),
      measuredAt: .now)
    status.lastRoundTripMilliseconds = probe.elapsedMilliseconds
    status.lastConnectionTestAt = probe.measuredAt
    update(profile.id, status)
    return probe
  }

  private func connectionLoop() async {
    var retry: UInt64 = 1
    while !stopped && !Task.isCancelled {
      do {
        try await connectOnce()
        retry = 1
      } catch is CancellationError {
        break
      } catch {
        failPending(error)
        publish(state: .offline, detail: error.localizedDescription)
        guard !stopped else { break }
        try? await Task.sleep(for: .seconds(retry))
        retry = min(retry * 2, 15)
      }
    }
  }

  private func connectOnce() async throws {
    publish(state: .connecting, detail: "Connecting")
    let connectionSession: URLSession
    if profile.connectionMode == .nearby, let fingerprint = profile.certificateSHA256 {
      let delegate = PinnedCertificateDelegate(fingerprintSHA256: fingerprint)
      trustDelegate = delegate
      connectionSession = URLSession(
        configuration: .ephemeral, delegate: delegate,
        delegateQueue: OperationQueue())
      session = connectionSession
    } else {
      connectionSession = .shared
    }
    let socket = connectionSession.webSocketTask(with: profile.url)
    task = socket
    socket.resume()
    let auth = AuthEnvelope(type: "auth", protocol: 1, token: token)
    try await socket.send(.data(JSONEncoder().encode(auth)))

    while !stopped && !Task.isCancelled {
      let message = try await socket.receive()
      let data: Data
      switch message {
      case .data(let value): data = value
      case .string(let value): data = Data(value.utf8)
      @unknown default: continue
      }
      guard data.count <= 64 * 1024 else { throw RelayConnectionError.messageTooLarge }
      let event = try JSONDecoder().decode(RelayServerEvent.self, from: data)
      handle(event)
    }
  }

  private func handle(_ event: RelayServerEvent) {
    switch event {
    case .ready(let host, let metadata):
      status.host = host
      status.relayProtocol = 1
      status.capabilities = metadata.capabilities
      status.bridgeKind = metadata.bridge
      status.requiresRepair = false
      publish(state: .ready, detail: nil)
    case .snapshot(let snapshot):
      let receivedAt = Date()
      status.host = snapshot.host
      status.snapshot = snapshot.normalizedToReceiptTime(
        receivedAt.timeIntervalSince1970 * 1_000)
      status.lastSnapshotReceivedAt = receivedAt
      status.requiresRepair = false
      publish(state: .ready, detail: nil)
    case .health(let host, let reason, _):
      status.host = host
      publish(state: .degraded, detail: reason.replacingOccurrences(of: "-", with: " ").capitalized)
    case .result(let requestID, let ok, let error):
      guard let continuation = pending.removeValue(forKey: requestID) else { return }
      if ok {
        continuation.resume()
      } else {
        continuation.resume(throwing: RelayConnectionError.commandFailed(error ?? "Command failed"))
      }
    }
  }

  private func publish(state newState: NodeConnectionState, detail: String?) {
    status.state = newState
    status.detail = detail
    status.changedAt = Date()
    update(profile.id, status)
  }

  private func failPending(_ error: Error) {
    let continuations = pending.values
    pending.removeAll()
    continuations.forEach { $0.resume(throwing: error) }
  }

  private struct AuthEnvelope: Encodable {
    let type: String
    let `protocol`: Int
    let token: String
  }

  private struct CommandEnvelope: Encodable {
    let type: String
    let `protocol`: Int
    let requestId: String
    let command: RelayCommand
  }
}

private final class PinnedCertificateDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
  private let expected: String

  init(fingerprintSHA256: String) {
    expected = NearbyNode.normalizeFingerprint(fingerprintSHA256)
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
      .map { String(format: "%02x", $0) }.joined()
    guard digest == expected else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
}

enum RelayConnectionError: LocalizedError {
  case notConnected
  case messageTooLarge
  case commandFailed(String)

  var errorDescription: String? {
    switch self {
    case .notConnected: "That Codex host is not connected."
    case .messageTooLarge: "Relay message exceeded the safe size limit."
    case .commandFailed(let message): message
    }
  }
}
