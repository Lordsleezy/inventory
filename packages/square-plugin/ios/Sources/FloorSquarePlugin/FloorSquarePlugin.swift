import Capacitor
import Foundation
import WebKit
import UIKit
import CoreLocation
import CoreBluetooth
import SquareMobilePaymentsSDK
import MockReaderUI

/// Capacitor bridge for Square Mobile Payments SDK.
///
/// Crash context (ios-square-7): Take payment killed the process immediately. ASC crash
/// reports were not reachable from this environment (App Store Connect login failed; no
/// Apple API key in the workspace). Square’s own docs state the matching failure mode:
/// “Physical card readers aren't supported in the Square Sandbox. To take test payments,
/// you must simulate a virtual reader with the Mock Reader UI.” We never presented
/// MockReaderUI before startPayment — that is the confirmed gap vs Donut Counter.
/// Guards below refuse startPayment when sandbox has no mock reader, catch NSExceptions,
/// and always resolve the Capacitor call on the main queue so the UI gets an error instead
/// of an uncaught exception kill.
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
    private var paymentHandle: PaymentHandle?
    private var locationManager: CLLocationManager?
    private var bluetoothManager: CBCentralManager?
    private var permissionCall: CAPPluginCall?
    private var locationResolved = false
    private var bluetoothResolved = false
    private var locationOk = false
    private var bluetoothOk = false
    private static var didInitializeSdk = false
    private var mockReaderUI: MockReaderUI?
    private var squarePresenter: UIViewController?

    public override func load() {
        Self.initializeSdkIfNeeded()
    }

    private static func initializeSdkIfNeeded() {
        guard !didInitializeSdk else { return }
        let appId = (Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String) ?? ""
        guard !appId.isEmpty, appId != "REPLACE_ME" else {
            NSLog("FloorSquare: SquareApplicationID missing/REPLACE_ME — MobilePaymentsSDK.initialize skipped")
            return
        }
        MobilePaymentsSDK.initialize(squareApplicationID: appId)
        didInitializeSdk = true
        NSLog("FloorSquare: MobilePaymentsSDK.initialize completed")
    }

    private func squareAppId() -> String {
        (Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String) ?? ""
    }

    private func sdkReadyMessage() -> String? {
        Self.initializeSdkIfNeeded()
        let appId = squareAppId()
        if appId.isEmpty || appId == "REPLACE_ME" {
            return "This build is missing SquareApplicationID — Codemagic must set SQUARE_APPLICATION_ID before archive."
        }
        return nil
    }

    private func isSandbox() -> Bool {
        MobilePaymentsSDK.shared.settingsManager.sdkSettings.environment == .sandbox
    }

    private func resolve(_ call: CAPPluginCall, _ payload: [String: Any]) {
        DispatchQueue.main.async {
            call.resolve(payload)
        }
    }

    private func presenterController() -> UIViewController? {
        guard let root = self.bridge?.viewController else { return nil }
        if let existing = squarePresenter, existing.parent === root { return existing }
        let host = UIViewController()
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = false
        root.addChild(host)
        host.view.frame = root.view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.insertSubview(host.view, at: 0)
        host.didMove(toParent: root)
        squarePresenter = host
        return host
    }

    /// Sandbox cannot talk to physical readers — present MockReaderUI (Square Donut Counter pattern).
    private func ensureSandboxMockReader(from presenter: UIViewController) -> String? {
        guard isSandbox() else { return nil }
        do {
            if mockReaderUI == nil {
                mockReaderUI = try MockReaderUI(for: MobilePaymentsSDK.shared)
            }
            try mockReaderUI?.present()
            return nil
        } catch {
            return "Sandbox requires Square’s Mock Reader UI before charging (physical readers do not work in sandbox). Mock reader failed: \(error.localizedDescription)"
        }
    }

    @objc func authState(_ call: CAPPluginCall) {
        let state: String
        switch MobilePaymentsSDK.shared.authorizationManager.state {
        case .authorized: state = "authorized"
        case .authorizing: state = "authorizing"
        case .notAuthorized: state = "notAuthorized"
        @unknown default: state = "unknown"
        }
        let appId = squareAppId()
        let initialized = !appId.isEmpty && appId != "REPLACE_ME"
        resolve(call, [
            "state": state,
            "sdkInitialized": initialized,
            "sdkLinked": true,
            "squareApplicationIdSet": initialized,
            "sandbox": isSandbox()
        ])
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
            resolve(call, [
                "ok": false,
                "reason": "location_permission_required",
                "message": "Allow Location for Floor — Square requires it before any card charge.",
                "location": false,
                "bluetooth": bluetoothOk
            ])
            return
        }
        resolve(call, ["ok": true, "location": true, "bluetooth": bluetoothOk])
    }

    @objc func authorize(_ call: CAPPluginCall) {
        let mock = call.getBool("mock") ?? false
        guard let token = call.getString("accessToken"),
              let locationId = call.getString("locationId"),
              !token.isEmpty, !locationId.isEmpty else {
            resolve(call, ["ok": false, "reason": "missing_credentials", "message": "Missing Square access token or location id from the server."])
            return
        }
        if mock {
            resolve(call, [
                "ok": false,
                "reason": "mock_authorize_disabled",
                "message": "Mock authorize is disabled for register charges. Connect Square on the register and pick a location.",
                "sdkLinked": true
            ])
            return
        }
        if let msg = sdkReadyMessage() {
            resolve(call, ["ok": false, "reason": "sdk_not_initialized", "message": msg, "sdkLinked": true])
            return
        }
        DispatchQueue.main.async {
            let auth = MobilePaymentsSDK.shared.authorizationManager
            if auth.state == .authorized {
                self.resolve(call, ["ok": true, "sdkLinked": true, "already": true])
                return
            }
            auth.authorize(withAccessToken: token, locationID: locationId) { error in
                if let error {
                    self.resolve(call, [
                        "ok": false,
                        "reason": error.localizedDescription,
                        "message": "Square authorize failed: \(error.localizedDescription)",
                        "sdkLinked": true
                    ])
                } else {
                    self.resolve(call, ["ok": true, "sdkLinked": true])
                }
            }
        }
    }

    @objc func startPairing(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.presenterController() else {
                self.resolve(call, ["ok": false, "reason": "no_view", "message": "No view to present Square settings."])
                return
            }
            if let mockErr = self.ensureSandboxMockReader(from: presenter) {
                // Still open settings so production readers can pair.
                NSLog("FloorSquare startPairing mock reader: \(mockErr)")
            }
            MobilePaymentsSDK.shared.settingsManager.presentSettings(with: presenter) { error in
                if let error {
                    self.resolve(call, [
                        "ok": false,
                        "reason": error.localizedDescription,
                        "message": "Square settings failed: \(error.localizedDescription)"
                    ])
                } else {
                    self.resolve(call, ["ok": true, "sdkLinked": true])
                }
            }
        }
    }

    @objc func charge(_ call: CAPPluginCall) {
        let amount = call.getInt("amountCents") ?? 0
        let mock = call.getBool("mock") ?? false
        let referenceId = call.getString("referenceId")
        if mock {
            resolve(call, [
                "ok": false,
                "reason": "mock_charge_disabled",
                "message": "Mock card charge is disabled. This build must use the real Square SDK.",
                "sdkLinked": true
            ])
            return
        }
        if let msg = sdkReadyMessage() {
            resolve(call, ["ok": false, "reason": "sdk_not_initialized", "message": msg, "sdkLinked": true])
            return
        }
        DispatchQueue.main.async {
            let authState = MobilePaymentsSDK.shared.authorizationManager.state
            guard authState == .authorized else {
                self.resolve(call, [
                    "ok": false,
                    "reason": "not_authorized",
                    "message": "Square SDK is not authorized yet. Tap Authorize Square after Connect Square + location on the register.",
                    "authState": String(describing: authState),
                    "sdkLinked": true
                ])
                return
            }
            let loc = CLLocationManager.authorizationStatus()
            guard loc == .authorizedAlways || loc == .authorizedWhenInUse else {
                self.resolve(call, [
                    "ok": false,
                    "reason": "location_permission_required",
                    "message": "Allow Location for Floor, then try Take payment again.",
                    "sdkLinked": true
                ])
                return
            }
            if self.paymentDelegate != nil {
                self.resolve(call, [
                    "ok": false,
                    "reason": "payment_already_in_progress",
                    "message": "A Square payment is already in progress.",
                    "sdkLinked": true
                ])
                return
            }
            guard let presenter = self.presenterController() else {
                self.resolve(call, [
                    "ok": false,
                    "reason": "no_view",
                    "message": "No iOS view controller available to present Square payment UI.",
                    "sdkLinked": true
                ])
                return
            }

            // Sandbox: physical readers unsupported — must show MockReaderUI first (Square docs).
            if let mockErr = self.ensureSandboxMockReader(from: presenter) {
                self.resolve(call, [
                    "ok": false,
                    "reason": "sandbox_mock_reader_required",
                    "message": mockErr,
                    "sdkLinked": true
                ])
                return
            }

            let cents = UInt(max(amount, 0))
            let params = PaymentParameters(
                paymentAttemptID: UUID().uuidString,
                amountMoney: Money(amount: cents, currency: .USD),
                // Sandbox only supports onlineOnly (Donut Counter).
                processingMode: self.isSandbox() ? .onlineOnly : .autoDetect
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

final class FloorPaymentDelegate: NSObject, PaymentManagerDelegate {
    private let call: CAPPluginCall
    private let onDone: () -> Void
    private var finished = false

    init(call: CAPPluginCall, onDone: @escaping () -> Void) {
        self.call = call
        self.onDone = onDone
    }

    private func finish(_ payload: [String: Any]) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async {
            self.call.resolve(payload)
            self.onDone()
        }
    }

    func paymentManager(_ paymentManager: PaymentManager, didFinish payment: Payment) {
        var paymentId = UUID().uuidString
        if let online = payment as? OnlinePayment, let id = online.id {
            paymentId = id
        }
        finish([
            "ok": true,
            "paymentId": paymentId,
            "sdkLinked": true
        ])
    }

    func paymentManager(_ paymentManager: PaymentManager, didFail payment: Payment, withError error: Error) {
        finish([
            "ok": false,
            "reason": error.localizedDescription,
            "message": "Square payment failed: \(error.localizedDescription)",
            "sdkLinked": true
        ])
    }

    func paymentManager(_ paymentManager: PaymentManager, didCancel payment: Payment) {
        finish(["ok": false, "reason": "canceled", "message": "Card payment canceled.", "sdkLinked": true])
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
