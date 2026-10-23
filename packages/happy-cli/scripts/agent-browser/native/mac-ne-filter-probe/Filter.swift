// Content-filter system extension for the N4 measurement only (nativeReady stays OFF).
// Sees every new socket flow, logs who opened it and for whom, and optionally drops
// non-loopback flows attributed to one uid. It never inspects payloads.
import Foundation
import NetworkExtension
import os.log

private let flowLog = OSLog(subsystem: "com.saycode.nativeh.nefilterprobe", category: "flow")

/// audit_token_t is eight UInt32: auid, euid, egid, ruid, rgid, pid, asid, pidversion.
private func identity(_ token: Data?) -> (euid: Int64, pid: Int64) {
    guard let token, token.count == 32 else { return (-1, -1) }
    let words = token.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
    return (Int64(words[1]), Int64(words[5]))
}

private func isLoopback(_ host: String) -> Bool {
    host == "::1" || host.hasPrefix("127.") || host == "localhost"
}

/// mDNSResponder's uid. Its queries carry the requester as the app token only while the requester is alive.
private let mdnsResponderUid: Int64 = 65
/// How long a name refused for the blocked uid stays refused for mDNSResponder's own (undelegated) queries.
private let taintSeconds: TimeInterval = 120

private func normalized(_ name: String?) -> String? {
    guard var name = name?.lowercased(), !name.isEmpty else { return nil }
    if name.hasSuffix(".") { name.removeLast() }
    return name
}

@objc(FilterDataProvider)
final class FilterDataProvider: NEFilterDataProvider {
    private let taintLock = NSLock()
    private var taintedUntil: [String: Date] = [:]

    /// Read on every flow: saving a new configuration updates filterConfiguration without restarting the provider.
    private var blockUid: Int64? { (filterConfiguration.vendorConfiguration?["blockUid"] as? NSNumber)?.int64Value }

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        os_log(.default, log: flowLog, "start blockUid=%{public}lld", blockUid ?? -1)
        apply(NEFilterSettings(rules: [], defaultAction: .filterData)) { completionHandler($0) }
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        os_log(.default, log: flowLog, "stop reason=%{public}ld", reason.rawValue)
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        guard let socket = flow as? NEFilterSocketFlow else { return .allow() }
        let process = identity(flow.sourceProcessAuditToken)
        let app = identity(flow.sourceAppAuditToken)
        let remote = socket.remoteFlowEndpoint.map { "\($0)" } ?? "-"
        let local = socket.localFlowEndpoint.map { "\($0)" } ?? "-"
        var remoteHost = "-"
        if case let .hostPort(host, _)? = socket.remoteFlowEndpoint { remoteHost = "\(host)" }
        let byUid = blockUid != nil && (process.euid == blockUid || app.euid == blockUid) && !isLoopback(remoteHost)
        let byTaint = !byUid && blockUid != nil && process.euid == mdnsResponderUid && app.euid == mdnsResponderUid
            && isTainted(normalized(socket.remoteHostname), refusedNow: false)
        if byUid { _ = isTainted(normalized(socket.remoteHostname), refusedNow: true) }
        let drop = byUid || byTaint
        os_log(.default, log: flowLog,
               "flow procUid=%{public}lld procPid=%{public}lld appUid=%{public}lld appPid=%{public}lld family=%{public}d type=%{public}d proto=%{public}d dir=%{public}ld remote=%{public}@ local=%{public}@ hostname=%{public}@ verdict=%{public}@",
               process.euid, process.pid, app.euid, app.pid,
               socket.socketFamily, socket.socketType, socket.socketProtocol, flow.direction.rawValue,
               remote, local, socket.remoteHostname ?? "-", byUid ? "drop" : byTaint ? "drop-tainted" : "allow")
        return drop ? .drop() : .allow()
    }

    /// Records a name refused for the blocked uid, or reports whether it is still refused.
    private func isTainted(_ name: String?, refusedNow: Bool) -> Bool {
        guard let name else { return false }
        taintLock.lock(); defer { taintLock.unlock() }
        let now = Date()
        if refusedNow {
            taintedUntil[name] = now.addingTimeInterval(taintSeconds)
            if taintedUntil.count > 4096 { taintedUntil = taintedUntil.filter { $0.value > now } }
            return true
        }
        return (taintedUntil[name] ?? .distantPast) > now
    }
}

autoreleasepool { NEProvider.startSystemExtensionMode() }
dispatchMain()
