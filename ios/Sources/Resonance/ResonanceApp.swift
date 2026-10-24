import AVFoundation
import SwiftUI
import UIKit
import WebKit

@main
struct ResonanceApp: App {
    @Environment(\.scenePhase) private var phase
    private let server = LocalServer(root: webApp)

    init() {
        // The modem wants the raw microphone and the loudspeaker, not the earpiece, and must not stop other audio.
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .mixWithOthers])
    }

    var body: some Scene {
        WindowGroup {
            ResonanceView(url: server.url)
                .ignoresSafeArea()
                .background(Color(red: 0.063, green: 0.078, blue: 0.071))
        }
        .onChange(of: phase) { _, phase in
            // A phone relays only while it listens, as the web app's wake lock does.
            UIApplication.shared.isIdleTimerDisabled = phase == .active
            if phase == .active { server.start() }
        }
    }
}

/// xtool builds the app as a Swift package; the TestFlight build uses an Xcode project instead.
#if SWIFT_PACKAGE
private let webApp = Bundle.module.url(forResource: "Web", withExtension: nil)!
#else
private let webApp = Bundle.main.url(forResource: "Web", withExtension: nil)!
#endif

struct ResonanceView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> WebHost { WebHost() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isInspectable = true
        view.uiDelegate = context.coordinator
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// What a browser does for the page and a bare web view does not: permission prompts, dialogs,
/// links to other apps, and saving the files the page offers.
final class WebHost: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    private var saving: [ObjectIdentifier: URL] = [:]
    private weak var view: WKWebView?

    // iOS itself still asks the person once, with the reason in Info.plist.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        view = webView
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url, !Self.isOwn(url) else { return decisionHandler(.allow) }
        // sms:, mailto:, tel: and web links belong to the apps that handle them.
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, !Self.isOwn(url) { UIApplication.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        view = webView
        if ProcessInfo.processInfo.arguments.contains("-smoke") { Self.report(webView) }
    }

    // MARK: Dialogs

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, from: webView, otherwise: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, from: webView) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, from: webView) { completionHandler(nil) }
    }

    // MARK: Downloads (spreadsheets, sound files, received files)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(suggestedFilename.isEmpty ? "resonance" : suggestedFilename)
        saving[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = saving.removeValue(forKey: ObjectIdentifier(download)), let view else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(share, from: view) {}
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        saving.removeValue(forKey: ObjectIdentifier(download))
    }

    // MARK: Helpers

    private static func isOwn(_ url: URL) -> Bool {
        ["blob", "data", "about"].contains(url.scheme) || url.host == "127.0.0.1"
    }

    private func present(_ controller: UIViewController, from view: WKWebView, otherwise: () -> Void) {
        guard var top = view.window?.rootViewController else { return otherwise() }
        while let next = top.presentedViewController { top = next }
        top.present(controller, animated: true)
    }

    /// For the cloud check on a simulated iPhone: prints whether the page loaded as a secure page
    /// with everything the modem needs.
    private static func report(_ view: WKWebView) {
        let probe = """
        JSON.stringify({ title: document.title, secure: isSecureContext, crypto: !!(crypto && crypto.subtle),
          microphone: typeof navigator.mediaDevices?.getUserMedia, worklet: typeof AudioWorkletNode,
          locks: !!navigator.locks, text: document.body.innerText.slice(0, 400) })
        """
        view.evaluateJavaScript(probe) { result, error in
            print("RESONANCE-SMOKE \(result ?? "error: \(String(describing: error))")")
            fflush(stdout)
        }
    }
}
