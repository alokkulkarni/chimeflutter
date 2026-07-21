import Foundation
import UIKit

/// App-wide entry point for the embedded support call — the "integrate once, launch from anywhere"
/// seam. The heavy integration (cached FlutterEngine + host bridge + the sheet that hosts the call
/// UI) lives at app level (``AppDelegate`` / the root view); feature screens never touch any of it.
/// Any screen, feature module, or deep-link handler starts a call with one line:
///
///     SupportCallLauncher.shared.launch(context: ["issueType": "billing", "lastScreen": "payments"])
///
/// `context` is that entry point's routing contribution. The host bridge overlays it on the
/// app-wide base context (identity/tier) in `getCustomerContext`, and the backend forwards the
/// allow-listed keys to Amazon Connect as contact attributes — so each feature controls how its
/// calls are routed without declaring any integration of its own.
final class SupportCallLauncher {
    static let shared = SupportCallLauncher()
    private init() {}

    /// The launching feature's context — read by the host bridge on the next `getCustomerContext`.
    private(set) var launchContext: [String: String] = [:]

    func launch(context: [String: String] = [:]) {
        launchContext = context
        NotificationCenter.default.post(name: .chimeCallRequested, object: nil)
    }
}

extension Notification.Name {
    /// Posted by ``SupportCallLauncher``; observed by the root view, which presents the call sheet.
    static let chimeCallRequested = Notification.Name("chimeCallRequested")
}
