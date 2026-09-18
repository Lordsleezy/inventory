import Capacitor
import Foundation
import UIKit
import WebKit

@objc(FloorSquarePlugin)
public class FloorSquarePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FloorSquarePlugin"
    public let jsName = "FloorSquare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "charge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAuth", returnType: CAPPluginReturnPromise)
    ]

    @objc func authorize(_ call: CAPPluginCall) {
        call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
    }

    @objc func charge(_ call: CAPPluginCall) {
        call.reject("square_not_linked")
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

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.05, green: 0.04, blue: 0.04, alpha: 1)
        title = "Connect"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close,
            target: self,
            action: #selector(cancel)
        )
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        view.addSubview(webView)
        webView.load(URLRequest(url: startURL))
    }

    @objc private func cancel() {
        finish(ok: false, error: "cancelled")
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, url.scheme == "floor" {
            decisionHandler(.cancel)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            let ok = items?.first(where: { $0.name == "ok" })?.value == "1"
            finish(ok: ok, error: ok ? nil : (items?.first(where: { $0.name == "error" })?.value))
            return
        }
        decisionHandler(.allow)
    }

    private func finish(ok: Bool, error: String?) {
        guard !finished else { return }
        finished = true
        dismiss(animated: true) {
            if ok {
                self.call.resolve(["ok": true])
            } else {
                self.call.reject(error ?? "oauth_failed")
            }
        }
    }
}
