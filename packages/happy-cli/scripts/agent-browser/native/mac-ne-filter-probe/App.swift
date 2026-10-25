// Container for the content-filter probe. Launch it as an app so macOS can show its consent alerts:
//   open -W --stdout out.log -a /Applications/SaycodeNEProbe.app --args activate | deactivate | enable [blockUid] | disable | status
// activate/deactivate install or remove the system extension (System Settings approval);
// enable/disable turn the filter configuration on or off (macOS asks once to allow it).
// The consent alert is auto-denied unless this app is frontmost, so a plain double-click means `enable`.
import AppKit
import NetworkExtension
import SystemExtensions

let extensionId = "com.saycode.nativeh.nefilterprobe.filter"

final class Requests: NSObject, OSSystemExtensionRequestDelegate {
    func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        print("replacing \(existing.bundleShortVersion) with \(ext.bundleShortVersion)")
        return .replace
    }
    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        print("needs-user-approval: System Settings > General > Login Items & Extensions > Network Extensions")
    }
    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        print(result == .completed ? "completed" : "will-complete-after-reboot")
        exit(0)
    }
    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let e = error as NSError
        print("failed: \(e.domain) \(e.code) \(e.localizedDescription)")
        exit(1)
    }
}

func finish(_ error: Error?, _ ok: String) {
    if let e = error as NSError? { print("failed: \(e.domain) \(e.code) \(e.localizedDescription)"); exit(1) }
    print(ok); exit(0)
}

let delegate = Requests()
NSApplication.shared.setActivationPolicy(.regular)
NSApp.activate(ignoringOtherApps: true)
let args = CommandLine.arguments.dropFirst()
let manager = NEFilterManager.shared()

switch args.first ?? "enable" {
case "activate", "deactivate":
    let request = args.first == "activate"
        ? OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionId, queue: .main)
        : OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: extensionId, queue: .main)
    request.delegate = delegate
    OSSystemExtensionManager.shared.submitRequest(request)
case "enable":
    manager.loadFromPreferences { error in
        if error != nil { finish(error, "") }
        let config = NEFilterProviderConfiguration()
        config.filterSockets = true
        config.filterPackets = false
        config.filterDataProviderBundleIdentifier = extensionId
        if let uid = args.dropFirst().first.flatMap(Int.init) { config.vendorConfiguration = ["blockUid": uid] }
        manager.providerConfiguration = config
        manager.localizedDescription = "Saycode NE filter probe"
        manager.isEnabled = true
        manager.saveToPreferences { finish($0, "enabled blockUid=\(config.vendorConfiguration?["blockUid"] ?? "none")") }
    }
case "disable":
    manager.loadFromPreferences { error in
        if error != nil { finish(error, "") }
        manager.removeFromPreferences { finish($0, "removed") }
    }
case "status":
    manager.loadFromPreferences { error in
        let config = manager.providerConfiguration
        finish(error, "enabled=\(manager.isEnabled) blockUid=\(config?.vendorConfiguration?["blockUid"] ?? "none") provider=\(config?.filterDataProviderBundleIdentifier ?? "-")")
    }
default:
    print("usage: SaycodeNEProbe activate | deactivate | enable [blockUid] | disable | status")
    exit(2)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 600) { print("timed-out"); exit(3) }
NSApp.run()
