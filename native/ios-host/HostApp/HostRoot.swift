import Flutter
import SwiftUI
import UIKit

/// Placeholder for the host's real auth/session. Replace with your identity layer.
final class AuthService {
    static let shared = AuthService()
    var customerTier: String { "gold" }
    func currentJwt() -> String {
        // Return your app's own session/bearer token here if you front the backend API with auth
        // (it is sent as `Authorization: Bearer <token>`). Empty = no Authorization header.
        ProcessInfo.processInfo.environment["DEMO_JWT"] ?? ""
    }
}

enum UIHostingControllerFactory {
    static func make(app: AppDelegate) -> UIViewController {
        UIHostingController(rootView: HomeView(app: app))
    }
}

/// Native SwiftUI home. "Call support" presents the embedded Flutter call UI (backed by the
/// pre-warmed engine) and asks it to start a call — the plugin then reports it to CallKit, so iOS
/// shows a real system call.
struct HomeView: View {
    let app: AppDelegate
    @State private var showingCall = false
    @State private var callActive = false
    @State private var callState = ""

    var body: some View {
        // The green call bar sits ABOVE the NavigationView (WhatsApp-style), so it is part of the
        // top chrome and persists across every pushed screen while the call runs minimized.
        VStack(spacing: 0) {
            if callActive && !showingCall {
                Button {
                    showingCall = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "phone.fill")
                        Text(callState == "connected" ? "Call in progress — tap to return"
                                                      : "Call \(callState) — tap to return")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                    .background(Color.green)
                    .foregroundColor(.white)
                }
                .transition(.move(edge: .top))
            }

            NavigationView {
                VStack(spacing: 24) {
                    Spacer()
                    Image(systemName: "creditcard").font(.system(size: 64)).foregroundColor(.indigo)
                    Text("Your account").font(.title)
                    Button {
                        // Launch via the app-wide launcher with THIS entry point's routing
                        // context — the sheet presentation and Flutter integration stay at root.
                        SupportCallLauncher.shared.launch(context: [
                            "issueType": "general",
                            "lastScreen": "home",
                        ])
                    } label: {
                        Label("Call support", systemImage: "phone.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.horizontal, 40)
                    // Demo screen proving the call bar persists while browsing other screens.
                    NavigationLink("Account details") {
                        List {
                            Label("Card •••• 4242", systemImage: "creditcard")
                            Label("Balance £1,234.56", systemImage: "sterlingsign.circle")
                            Label("Next payment 1 Aug", systemImage: "calendar")
                        }
                        .navigationTitle("Account details")
                    }
                    // A separate FEATURE screen with its own call entry point — proves any screen
                    // can start a call (with its own context) without extra integration.
                    NavigationLink("Payments") { PaymentsView() }
                    Spacer()
                }
                .navigationTitle("Home")
            }
        }
        .animation(.easeInOut(duration: 0.2), value: callActive)
        // iOS-native minimize: the call screen is a sheet — customers swipe DOWN to return to the
        // app (same gesture as WhatsApp/FaceTime); the call keeps running.
        .sheet(isPresented: $showingCall) {
            FlutterCallView(engine: app.flutterEngine)
                .ignoresSafeArea()
                .dragIndicatorIfAvailable()
        }
        .onReceive(NotificationCenter.default.publisher(for: .chimeCallStateChanged)) { note in
            let state = note.userInfo?["state"] as? String ?? ""
            callState = state
            callActive = ["connecting", "ringing", "connected", "reconnecting"].contains(state)
        }
        .onReceive(NotificationCenter.default.publisher(for: .chimeCallMinimized)) { _ in
            showingCall = false // call keeps running; the green bar takes over
        }
        .onReceive(NotificationCenter.default.publisher(for: .chimeCallEnded)) { _ in
            callActive = false
            showingCall = false
        }
        // Any screen can request a call via SupportCallLauncher — the ONE sheet here presents it.
        .onReceive(NotificationCenter.default.publisher(for: .chimeCallRequested)) { _ in
            showingCall = true
        }
    }
}

/// A demo FEATURE screen: proves any screen can start a support call with its own routing context
/// (billing, payments, a product id) without touching the Flutter integration — the engine,
/// bridge and call sheet all live once at app level.
struct PaymentsView: View {
    var body: some View {
        List {
            Section("Recent payments") {
                Label("£120.00 — Acme Energy", systemImage: "bolt.fill")
                Label("£54.20 — City Water", systemImage: "drop.fill")
            }
            Section {
                Button {
                    SupportCallLauncher.shared.launch(context: [
                        "issueType": "billing",
                        "lastScreen": "payments",
                        "productId": "PAY-8842",
                    ])
                } label: {
                    Label("Call about a payment", systemImage: "phone.fill")
                }
            }
        }
        .navigationTitle("Payments")
    }
}

extension View {
    /// Sheet drag indicator on iOS 16+; plain sheet (still swipe-dismissable) on iOS 15.
    @ViewBuilder func dragIndicatorIfAvailable() -> some View {
        if #available(iOS 16.0, *) {
            self.presentationDragIndicator(.visible)
        } else {
            self
        }
    }
}

/// Hosts the Flutter call screen (backed by the cached engine) inside SwiftUI.
struct FlutterCallView: UIViewControllerRepresentable {
    let engine: FlutterEngine
    func makeUIViewController(context: Context) -> FlutterViewController {
        FlutterViewController(engine: engine, nibName: nil, bundle: nil)
    }
    func updateUIViewController(_ uiViewController: FlutterViewController, context: Context) {}
}
