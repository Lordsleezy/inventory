import Capacitor
import Foundation
import WebKit
import UIKit

#if canImport(SquareMobilePaymentsSDK)
import SquareMobilePaymentsSDK
#endif

/// Capacitor bridge for Square Mobile Payments SDK (Donut Counter pattern).
/// Sandbox: pass mock=true or use Mock Reader UI when the SDK is linked.
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

    private var authorized = false

    @objc func authorize(_ call: CAPPluginCall) {
        let mock = call.getBool("mock") ?? false
        #if canImport(SquareMobilePaymentsSDK)
        guard let token = call.getString("accessToken"),
              let locationId = call.getString("locationId") else {
            call.resolve(["ok": false, "reason": "missing_credentials"])
            return
        }
        if mock {
            self.authorized = true
            call.resolve(["ok": true, "mock": true])
            return
        }
        DispatchQueue.main.async {
            MobilePaymentsSDK.shared.authorizationManager.authorize(
                withAccessToken: token,
                locationID: locationId
            ) { error in
                if let error {
                    call.resolve(["ok": false, "reason": error.localizedDescription])
                } else {
                    self.authorized = true
                    call.resolve(["ok": true])
                }
            }
        }
        #else
        if mock || call.getString("accessToken") != nil {
            self.authorized = true
            call.resolve(["ok": true, "mock": true])
        } else {
            call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
        }
        #endif
    }

    @objc func startPairing(_ call: CAPPluginCall) {
        #if canImport(SquareMobilePaymentsSDK)
        DispatchQueue.main.async {
            // Present Square's reader pairing UI when available.
            if let presenter = self.bridge?.viewController {
                MobilePaymentsSDK.shared.readerManager.presentSettings(from: presenter) { _ in
                    call.resolve(["ok": true])
                }
            } else {
                call.resolve(["ok": true, "mock": true])
            }
        }
        #else
        call.resolve(["ok": true, "mock": true])
        #endif
    }

    @objc func charge(_ call: CAPPluginCall) {
        let amount = call.getInt("amountCents") ?? 0
        let mock = call.getBool("mock") ?? false
        #if canImport(SquareMobilePaymentsSDK)
        if mock || !authorized {
            let id = "sq_mock_\(amount)_\(Int(Date().timeIntervalSince1970))"
            call.resolve([
                "ok": true,
                "paymentId": id,
                "cardBrand": "VISA",
                "cardLast4": "1111",
                "mock": true
            ])
            return
        }
        guard let presenter = self.bridge?.viewController else {
            call.resolve(["ok": false, "reason": "no_view"])
            return
        }
        DispatchQueue.main.async {
            let money = Money(amount: amount, currency: .USD)
            let params = PaymentParameters(
                processingMode: .onlineOnly,
                amountMoney: money,
                paymentAttemptID: UUID().uuidString
            )
            let prompt = PromptParameters(
                mode: .default,
                additionalMethods: .all
            )
            MobilePaymentsSDK.shared.paymentManager.startPayment(
                params,
                promptParameters: prompt,
                from: presenter
            ) { result, error in
                if let error {
                    call.resolve(["ok": false, "reason": error.localizedDescription])
                    return
                }
                guard let payment = result else {
                    call.resolve(["ok": false, "reason": "canceled"])
                    return
                }
                var brand: String? = nil
                var last4: String? = nil
                if let card = payment.cardDetails?.card {
                    brand = card.brand?.description
                    last4 = card.last4
                }
                call.resolve([
                    "ok": true,
                    "paymentId": payment.id ?? UUID().uuidString,
                    "cardBrand": brand as Any,
                    "cardLast4": last4 as Any
                ])
            }
        }
        #else
        let id = "stub_\(amount)_\(Int(Date().timeIntervalSince1970))"
        call.resolve([
            "ok": true,
            "paymentId": id,
            "cardBrand": "VISA",
            "cardLast4": "1111",
            "mock": true
        ])
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
