import Capacitor
import Foundation
import WebKit
import UIKit

#if canImport(SquareMobilePaymentsSDK)
import SquareMobilePaymentsSDK
#endif

/// Capacitor bridge for Square Mobile Payments SDK (Donut Counter pattern).
/// SquareMobilePaymentsSDK is a Package.swift dependency — Codemagic links it via CapApp-SPM.
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

    private var paymentDelegate: FloorPaymentDelegate?

    @objc func authorize(_ call: CAPPluginCall) {
        let mock = call.getBool("mock") ?? false
        #if canImport(SquareMobilePaymentsSDK)
        guard let token = call.getString("accessToken"),
              let locationId = call.getString("locationId"),
              !token.isEmpty, !locationId.isEmpty else {
            call.resolve(["ok": false, "reason": "missing_credentials"])
            return
        }
        if mock {
            call.resolve(["ok": true, "mock": true, "sdkLinked": true])
            return
        }
        DispatchQueue.main.async {
            MobilePaymentsSDK.shared.authorizationManager.authorize(
                withAccessToken: token,
                locationID: locationId
            ) { error in
                if let error {
                    call.resolve(["ok": false, "reason": error.localizedDescription, "sdkLinked": true])
                } else {
                    call.resolve(["ok": true, "sdkLinked": true])
                }
            }
        }
        #else
        call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
        #endif
    }

    @objc func startPairing(_ call: CAPPluginCall) {
        #if canImport(SquareMobilePaymentsSDK)
        // Reader pairing happens through Square's payment / settings UI after authorize.
        // Keep this a no-op success so the phone can show its pair code for the register.
        call.resolve(["ok": true, "sdkLinked": true])
        #else
        call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
        #endif
    }

    @objc func charge(_ call: CAPPluginCall) {
        let amount = call.getInt("amountCents") ?? 0
        let mock = call.getBool("mock") ?? false
        #if canImport(SquareMobilePaymentsSDK)
        if mock {
            call.resolve([
                "ok": true,
                "paymentId": "sq_mock_\(amount)_\(Int(Date().timeIntervalSince1970))",
                "cardBrand": "VISA",
                "cardLast4": "1111",
                "mock": true,
                "sdkLinked": true
            ])
            return
        }
        guard let presenter = self.bridge?.viewController else {
            call.resolve(["ok": false, "reason": "no_view", "sdkLinked": true])
            return
        }
        DispatchQueue.main.async {
            let params = PaymentParameters(
                paymentAttemptID: UUID().uuidString,
                amountMoney: Money(amount: amount, currency: .USD),
                processingMode: .onlineOnly
            )
            let prompt = PromptParameters(mode: .default, additionalMethods: .all)
            let delegate = FloorPaymentDelegate(call: call)
            self.paymentDelegate = delegate
            MobilePaymentsSDK.shared.paymentManager.startPayment(
                params,
                promptParameters: prompt,
                from: presenter,
                delegate: delegate
            )
        }
        #else
        call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
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

#if canImport(SquareMobilePaymentsSDK)
final class FloorPaymentDelegate: NSObject, PaymentManagerDelegate {
    private let call: CAPPluginCall
    private var finished = false

    init(call: CAPPluginCall) {
        self.call = call
    }

    func paymentManager(_ paymentManager: PaymentManager, didFinish payment: Payment) {
        guard !finished else { return }
        finished = true
        var paymentId = UUID().uuidString
        if let online = payment as? OnlinePayment, let id = online.id {
            paymentId = id
        }
        call.resolve([
            "ok": true,
            "paymentId": paymentId,
            "sdkLinked": true
        ])
    }

    func paymentManager(_ paymentManager: PaymentManager, didFail payment: Payment, withError error: Error) {
        guard !finished else { return }
        finished = true
        call.resolve(["ok": false, "reason": error.localizedDescription, "sdkLinked": true])
    }

    func paymentManager(_ paymentManager: PaymentManager, didCancel payment: Payment) {
        guard !finished else { return }
        finished = true
        call.resolve(["ok": false, "reason": "canceled", "sdkLinked": true])
    }
}
#endif

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
