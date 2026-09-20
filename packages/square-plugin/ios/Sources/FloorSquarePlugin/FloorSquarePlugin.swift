import Capacitor
import Foundation
import WebKit
import UIKit
import CoreLocation
import CoreBluetooth

#if canImport(SquareMobilePaymentsSDK)
import SquareMobilePaymentsSDK
#endif

/// Capacitor bridge for Square Mobile Payments SDK.
/// Hard rules: never startPayment unless SDK is initialized + authorized + location allowed.
@objc(FloorSquarePlugin)
public class FloorSquarePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate, CBCentralManagerDelegate {
    public let identifier = "FloorSquarePlugin"
    public let jsName = "FloorSquare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "charge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preparePermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authState", returnType: CAPPluginReturnPromise)
    ]

    private var paymentDelegate: FloorPaymentDelegate?
    private var paymentHandle: Any?
    private var locationManager: CLLocationManager?
    private var bluetoothManager: CBCentralManager?
    private var permissionCall: CAPPluginCall?
    private var locationResolved = false
    private var bluetoothResolved = false
    private var locationOk = false
    private var bluetoothOk = false

    @objc func authState(_ call: CAPPluginCall) {
        #if canImport(SquareMobilePaymentsSDK)
        let state: String
        switch MobilePaymentsSDK.shared.authorizationManager.state {
        case .authorized: state = "authorized"
        case .authorizing: state = "authorizing"
        case .notAuthorized: state = "notAuthorized"
        @unknown default: state = "unknown"
        }
        let appId = Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String ?? ""
        let initialized = !appId.isEmpty && appId != "REPLACE_ME"
        call.resolve(["state": state, "sdkInitialized": initialized, "sdkLinked": true])
        #else
        call.resolve(["state": "notLinked", "sdkInitialized": false, "sdkLinked": false])
        #endif
    }

    @objc func preparePermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.permissionCall = call
            self.locationResolved = false
            self.bluetoothResolved = false
            self.locationOk = false
            self.bluetoothOk = false

            let lm = CLLocationManager()
            self.locationManager = lm
            lm.delegate = self
            switch lm.authorizationStatus {
            case .authorizedAlways, .authorizedWhenInUse:
                self.locationOk = true
                self.locationResolved = true
            case .notDetermined:
                lm.requestWhenInUseAuthorization()
            default:
                self.locationOk = false
                self.locationResolved = true
            }

            // Creating CBCentralManager triggers the Bluetooth permission prompt on iOS 13+.
            self.bluetoothManager = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionShowPowerAlertKey: false
            ])
            self.finishPermissionsIfReady()
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            locationOk = true
            locationResolved = true
        case .notDetermined:
            break
        default:
            locationOk = false
            locationResolved = true
        }
        finishPermissionsIfReady()
    }

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn, .poweredOff, .resetting, .unauthorized, .unsupported, .unknown:
            // poweredOff is still OK for Tap to Pay; unauthorized means permission denied.
            bluetoothOk = central.state != .unauthorized && central.state != .unsupported
            bluetoothResolved = true
        @unknown default:
            bluetoothOk = true
            bluetoothResolved = true
        }
        finishPermissionsIfReady()
    }

    private func finishPermissionsIfReady() {
        guard let call = permissionCall, locationResolved, bluetoothResolved else { return }
        permissionCall = nil
        if !locationOk {
            call.resolve(["ok": false, "reason": "location_permission_required", "location": false, "bluetooth": bluetoothOk])
            return
        }
        call.resolve(["ok": true, "location": true, "bluetooth": bluetoothOk])
    }

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
            call.resolve(["ok": false, "reason": "mock_authorize_disabled", "sdkLinked": true])
            return
        }
        let appId = Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String ?? ""
        if appId.isEmpty || appId == "REPLACE_ME" {
            call.resolve(["ok": false, "reason": "sdk_not_initialized", "sdkLinked": true])
            return
        }
        DispatchQueue.main.async {
            let auth = MobilePaymentsSDK.shared.authorizationManager
            if auth.state == .authorized {
                call.resolve(["ok": true, "sdkLinked": true, "already": true])
                return
            }
            auth.authorize(withAccessToken: token, locationID: locationId) { error in
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
        call.resolve(["ok": true, "sdkLinked": true])
        #else
        call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
        #endif
    }

    @objc func charge(_ call: CAPPluginCall) {
        let amount = call.getInt("amountCents") ?? 0
        let mock = call.getBool("mock") ?? false
        let referenceId = call.getString("referenceId")
        #if canImport(SquareMobilePaymentsSDK)
        if mock {
            // Register path must never mock — refuse rather than fake a capture.
            call.resolve(["ok": false, "reason": "mock_charge_disabled", "sdkLinked": true])
            return
        }
        let appId = Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String ?? ""
        if appId.isEmpty || appId == "REPLACE_ME" {
            call.resolve(["ok": false, "reason": "sdk_not_initialized", "sdkLinked": true])
            return
        }
        guard let presenter = self.bridge?.viewController else {
            call.resolve(["ok": false, "reason": "no_view", "sdkLinked": true])
            return
        }
        DispatchQueue.main.async {
            let authState = MobilePaymentsSDK.shared.authorizationManager.state
            guard authState == .authorized else {
                call.resolve([
                    "ok": false,
                    "reason": "not_authorized",
                    "authState": String(describing: authState),
                    "sdkLinked": true
                ])
                return
            }
            let loc = CLLocationManager.authorizationStatus()
            guard loc == .authorizedAlways || loc == .authorizedWhenInUse else {
                call.resolve(["ok": false, "reason": "location_permission_required", "sdkLinked": true])
                return
            }
            if self.paymentDelegate != nil {
                call.resolve(["ok": false, "reason": "payment_already_in_progress", "sdkLinked": true])
                return
            }
            let cents = UInt(max(amount, 0))
            let params = PaymentParameters(
                paymentAttemptID: UUID().uuidString,
                amountMoney: Money(amount: cents, currency: .USD),
                processingMode: .onlineOnly
            )
            if let referenceId, !referenceId.isEmpty {
                params.referenceID = referenceId
            }
            let prompt = PromptParameters(mode: .default, additionalMethods: .all)
            let delegate = FloorPaymentDelegate(call: call) { [weak self] in
                self?.paymentDelegate = nil
                self?.paymentHandle = nil
            }
            self.paymentDelegate = delegate
            self.paymentHandle = MobilePaymentsSDK.shared.paymentManager.startPayment(
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
    private let onDone: () -> Void
    private var finished = false

    init(call: CAPPluginCall, onDone: @escaping () -> Void) {
        self.call = call
        self.onDone = onDone
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
        onDone()
    }

    func paymentManager(_ paymentManager: PaymentManager, didFail payment: Payment, withError error: Error) {
        guard !finished else { return }
        finished = true
        call.resolve(["ok": false, "reason": error.localizedDescription, "sdkLinked": true])
        onDone()
    }

    func paymentManager(_ paymentManager: PaymentManager, didCancel payment: Payment) {
        guard !finished else { return }
        finished = true
        call.resolve(["ok": false, "reason": "canceled", "sdkLinked": true])
        onDone()
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
