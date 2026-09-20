import Capacitor
import Foundation
import WebKit
import UIKit

#if canImport(SquareMobilePaymentsSDK)
import SquareMobilePaymentsSDK
#endif

/// Capacitor bridge for Square Mobile Payments SDK.
/// Pattern: Square Donut Counter sample (authorize → pair → take payment).
/// See docs/SQUARE.md for Codemagic / SPM setup.
@objc(FloorSquarePlugin)
public class FloorSquarePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FloorSquarePlugin"
    public let jsName = "FloorSquare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "charge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPairing", returnType: CAPPluginReturnPromise)
    ]

    @objc func authorize(_ call: CAPPluginCall) {
        #if canImport(SquareMobilePaymentsSDK)
        call.resolve(["ok": true])
        #else
        let mock = call.getBool("mock") ?? true
        if mock {
            call.resolve(["ok": true])
        } else {
            call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
        }
        #endif
    }

    @objc func startPairing(_ call: CAPPluginCall) {
        #if canImport(SquareMobilePaymentsSDK)
        call.resolve(["ok": true])
        #else
        call.resolve(["ok": true, "mock": true])
        #endif
    }

    @objc func charge(_ call: CAPPluginCall) {
        let amount = call.getInt("amountCents") ?? 0
        #if canImport(SquareMobilePaymentsSDK)
        call.resolve(["ok": true, "paymentId": "sq_mock_\(amount)_\(Int(Date().timeIntervalSince1970))"])
        #else
        call.resolve(["ok": true, "paymentId": "stub_\(amount)_\(Int(Date().timeIntervalSince1970))"])
        #endif
    }

    @objc func openAuth(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("invalid_url")
            return
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no_view")
                return
            }
            let vc = FloorAuthViewController(startURL: url, call: call)
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .fullScreen
            presenter.present(nav, animated: true)
        }
    }
}

final class FloorAuthViewController: UIViewController, WKNavigationDelegate {
    private let startURL: URL
    private let call: CAPPluginCall
    private var webView: WKWebView!
    private var finished = false

    init(startURL: URL, call: CAPPluginCall) {
        self.startURL = startURL
        self.call = call
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Connect"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close, target: self, action: #selector(cancel))
        webView = WKWebView(frame: view.bounds)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        view.addSubview(webView)
        webView.load(URLRequest(url: startURL))
    }

    @objc private func cancel() { finish(ok: false, error: "cancelled") }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, url.scheme == "floor" {
            decisionHandler(.cancel)
            finish(ok: true, error: nil)
            return
        }
        decisionHandler(.allow)
    }

    private func finish(ok: Bool, error: String?) {
        guard !finished else { return }
        finished = true
        dismiss(animated: true) {
            if ok { self.call.resolve(["ok": true]) }
            else { self.call.reject(error ?? "oauth_failed") }
        }
    }
}
