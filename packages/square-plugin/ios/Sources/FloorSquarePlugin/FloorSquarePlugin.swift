import Capacitor
import Foundation
import WebKit
import UIKit
import CoreLocation
import CoreBluetooth
import SquareMobilePaymentsSDK
#if canImport(MockReaderUI)
import MockReaderUI
#endif

/// Capacitor bridge for Square Mobile Payments SDK.
///
/// MockReaderUI is optional (linked only by CapApp-SPM for ad-hoc sandbox builds).
/// Square ships it as CFBundlePackageType=APPL with bundle id
/// com.squareup.readersdk.mockreaderui — App Store Connect rejects any IPA that embeds it.
/// Production / TestFlight builds omit the product; `#if canImport` keeps this file compiling.
@objc(FloorSquarePlugin)
public class FloorSquarePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate, CBCentralManagerDelegate {
    public let identifier = "FloorSquarePlugin"
    public let jsName = "FloorSquare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "charge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentMockReader", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preparePermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authState", returnType: CAPPluginReturnPromise)
    ]

    private var paymentDelegate: FloorPaymentDelegate?
    private var paymentHandle: PaymentHandle?
  private var locationManager: CLLocationManager?
  private var bluetoothManager: CBCentralManager?
  private var permissionCall: CAPPluginCall?
  private var locationAuthResolved = false
  private var locationFixResolved = false
  private var bluetoothResolved = false
  private var locationOk = false
  private var locationFixOk = false
  private var bluetoothOk = false
  private var lastFixLat: Double?
  private var lastFixLon: Double?
  private var lastFixAccuracy: Double?
  private var lastFixCountry: String?
    private static var didInitializeSdk = false
#if canImport(MockReaderUI)
    private var mockReaderUI: MockReaderUI?
#endif
    private var squarePresenter: UIViewController?

    public override func load() {
        // AppDelegate bootstraps with applicationLaunchOptions (Square's required path).
        // Cap plugins load after didFinishLaunching — do not initialize a second time.
        let appId = squareAppId()
        if !appId.isEmpty && appId != "REPLACE_ME" {
            Self.didInitializeSdk = true
            NSLog("FloorSquare plugin: AppDelegate should have initialized appIdPrefix=%@", String(appId.prefix(24)))
        }
    }

    private static func initializeSdkIfNeeded() {
        guard !didInitializeSdk else { return }
        let appId = (Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String) ?? ""
        guard !appId.isEmpty, appId != "REPLACE_ME" else {
            NSLog("FloorSquare: SquareApplicationID missing/REPLACE_ME — MobilePaymentsSDK.initialize skipped")
            return
        }
        // Fallback when AppDelegate did not run (rare). Prefer launchOptions path in AppDelegate.
        MobilePaymentsSDK.initialize(applicationLaunchOptions: nil, squareApplicationID: appId)
        didInitializeSdk = true
        NSLog("FloorSquare plugin: MobilePaymentsSDK.initialize fallback appIdPrefix=%@", String(appId.prefix(24)))
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

    /// Prefer Square's AuthorizationError / PaymentError enum names over generic "contact the developer".
    private func squareErrorFields(_ error: Error, prefix: String) -> [String: Any] {
        let ns = error as NSError
        var codeName = "NSError"
        var debug = error.localizedDescription
        if let auth = AuthorizationError(rawValue: ns.code) {
            codeName = String(describing: auth)
            if auth == .unsupportedCountry {
                debug = "authorization_unsupported_country — seller location or Application ID environment is wrong, or the phone GPS country could not be read as US/CA/GB/AU. Confirm sandbox Application ID matches Netlify, location country is US, Precise Location is on, and a GPS fix completed."
            }
        } else if let pay = PaymentError(rawValue: ns.code) {
            codeName = String(describing: pay)
        }
        if let info = ns.userInfo["SQErrorDebugCode"] as? String, !info.isEmpty {
            debug = info
            codeName = info
        } else if let info = ns.userInfo["debugCode"] as? String, !info.isEmpty {
            debug = info
            codeName = info
        } else if let info = ns.userInfo[NSLocalizedFailureReasonErrorKey] as? String, !info.isEmpty {
            debug = info
        }
        NSLog("FloorSquare \(prefix): code=\(ns.code) name=\(codeName) debug=\(debug) userInfo=\(ns.userInfo)")
        return [
            "reason": codeName,
            "code": ns.code,
            "message": "\(prefix) [\(codeName)]: \(debug)",
            "localizedDescription": error.localizedDescription,
            "sdkLinked": true
        ]
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

    /// Sandbox cannot talk to physical readers — present MockReaderUI when linked (ad-hoc builds).
    private func ensureSandboxMockReader(from presenter: UIViewController) -> String? {
        guard isSandbox() else { return nil }
#if canImport(MockReaderUI)
        do {
            if mockReaderUI == nil {
                mockReaderUI = try MockReaderUI(for: MobilePaymentsSDK.shared)
            }
            try mockReaderUI?.present()
            return nil
        } catch {
            return "Sandbox requires Square’s Mock Reader UI before charging (physical readers do not work in sandbox). Mock reader failed: \(error.localizedDescription)"
        }
#else
        return "This build has no MockReaderUI (App Store / TestFlight cannot embed it). Install an ios-square-* ad-hoc build to take sandbox card payments."
#endif
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
        let locationId = MobilePaymentsSDK.shared.authorizationManager.location?.id
        resolve(call, [
            "state": state,
            "sdkInitialized": initialized,
            "sdkLinked": true,
            "squareApplicationIdSet": initialized,
            "squareApplicationId": appId,
            "locationId": locationId as Any,
            "sandbox": isSandbox(),
            "mockReaderLinked": {
#if canImport(MockReaderUI)
                return true
#else
                return false
#endif
            }()
        ])
    }

    @objc func preparePermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.permissionCall = call
            self.locationAuthResolved = false
            self.locationFixResolved = false
            self.bluetoothResolved = false
            self.locationOk = false
            self.locationFixOk = false
            self.bluetoothOk = false
            self.lastFixLat = nil
            self.lastFixLon = nil
            self.lastFixAccuracy = nil
            self.lastFixCountry = nil

            let lm = CLLocationManager()
            self.locationManager = lm
            lm.delegate = self
            lm.desiredAccuracy = kCLLocationAccuracyHundredMeters
            switch lm.authorizationStatus {
            case .authorizedAlways, .authorizedWhenInUse:
                self.locationOk = true
                self.locationAuthResolved = true
                // Square uses the device GPS country for authorize — permission alone is not enough.
                lm.requestLocation()
            case .notDetermined:
                lm.requestWhenInUseAuthorization()
            default:
                self.locationOk = false
                self.locationAuthResolved = true
                self.locationFixResolved = true
                self.locationFixOk = false
            }

            self.bluetoothManager = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionShowPowerAlertKey: false
            ])
            self.finishPermissionsIfReady()

            // Never hang Authorize forever if a permission/fix callback is dropped.
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                guard let self, let pending = self.permissionCall, pending === call else { return }
                if !self.locationAuthResolved {
                    self.locationOk = false
                    self.locationAuthResolved = true
                    self.locationFixResolved = true
                    self.locationFixOk = false
                } else if self.locationOk && !self.locationFixResolved {
                    self.locationFixResolved = true
                    self.locationFixOk = false
                }
                if !self.bluetoothResolved {
                    self.bluetoothOk = true
                    self.bluetoothResolved = true
                }
                self.finishPermissionsIfReady()
            }
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            locationOk = true
            locationAuthResolved = true
            manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
            manager.requestLocation()
        case .notDetermined:
            break
        default:
            locationOk = false
            locationAuthResolved = true
            locationFixResolved = true
            locationFixOk = false
            finishPermissionsIfReady()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        lastFixLat = loc.coordinate.latitude
        lastFixLon = loc.coordinate.longitude
        lastFixAccuracy = loc.horizontalAccuracy
        locationFixOk = loc.horizontalAccuracy >= 0
        NSLog("FloorSquare location fix: lat=\(loc.coordinate.latitude) lon=\(loc.coordinate.longitude) acc=\(loc.horizontalAccuracy)")
        // Reverse-geocode so we can show device ISO country before authorize (Square error 13).
        CLGeocoder().reverseGeocodeLocation(loc) { [weak self] placemarks, error in
            guard let self else { return }
            if let err = error {
                NSLog("FloorSquare reverse geocode failed: \(err.localizedDescription)")
                self.lastFixCountry = nil
            } else {
                self.lastFixCountry = placemarks?.first?.isoCountryCode
                NSLog("FloorSquare device country=\(self.lastFixCountry ?? "nil")")
            }
            self.locationFixResolved = true
            self.finishPermissionsIfReady()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("FloorSquare location fix failed: \(error.localizedDescription)")
        locationFixOk = false
        locationFixResolved = true
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
        guard let call = permissionCall, locationAuthResolved, bluetoothResolved else { return }
        if locationOk && !locationFixResolved { return }
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
        if !locationFixOk {
            resolve(call, [
                "ok": false,
                "reason": "location_fix_required",
                "message": "Location permission is on, but iOS has not given Floor a GPS fix yet. Turn on Precise Location, wait outdoors/near a window a few seconds, then Authorize again.",
                "location": true,
                "locationFix": false,
                "bluetooth": bluetoothOk
            ])
            return
        }
        var payload: [String: Any] = [
            "ok": true,
            "location": true,
            "locationFix": true,
            "bluetooth": bluetoothOk
        ]
        if let lat = lastFixLat { payload["latitude"] = lat }
        if let lon = lastFixLon { payload["longitude"] = lon }
        if let acc = lastFixAccuracy { payload["accuracyMeters"] = acc }
        if let country = lastFixCountry { payload["deviceCountry"] = country }
        if let localeRegion = Locale.current.regionCode { payload["localeRegion"] = localeRegion }
        resolve(call, payload)
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
        let appId = squareAppId()
        NSLog("FloorSquare authorize: appId=\(appId) locationId=\(locationId) tokenLen=\(token.count) sandbox=\(isSandbox())")
        DispatchQueue.main.async {
            let auth = MobilePaymentsSDK.shared.authorizationManager
            let currentLocation = auth.location?.id as String?
            if auth.state == .authorized, currentLocation == locationId {
                NSLog("FloorSquare authorize: already authorized location=\(locationId)")
                self.resolve(call, [
                    "ok": true,
                    "sdkLinked": true,
                    "already": true,
                    "locationId": locationId,
                    "squareApplicationId": appId,
                    "sandbox": self.isSandbox()
                ])
                return
            }
            let finishAuthorize: (Error?) -> Void = { error in
                if let error {
                    var fields = self.squareErrorFields(error, prefix: "Square authorize failed")
                    fields["ok"] = false
                    fields["locationId"] = locationId
                    fields["squareApplicationId"] = appId
                    fields["sandbox"] = self.isSandbox()
                    self.resolve(call, fields)
                } else {
                    let state = MobilePaymentsSDK.shared.authorizationManager.state
                    NSLog("FloorSquare authorize: success state=\(String(describing: state)) location=\(locationId)")
                    self.resolve(call, [
                        "ok": true,
                        "sdkLinked": true,
                        "locationId": locationId,
                        "squareApplicationId": appId,
                        "sandbox": self.isSandbox(),
                        "authState": String(describing: state)
                    ])
                }
            }
            if auth.state == .authorized, currentLocation != locationId {
                NSLog("FloorSquare authorize: deauthorize old location=\(currentLocation ?? "nil") → \(locationId)")
                auth.deauthorize {
                    auth.authorize(withAccessToken: token, locationID: locationId, completion: finishAuthorize)
                }
                return
            }
            auth.authorize(withAccessToken: token, locationID: locationId, completion: finishAuthorize)
        }
    }

    @objc func presentMockReader(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.presenterController() else {
                self.resolve(call, ["ok": false, "reason": "no_view", "message": "No view to present Mock Reader."])
                return
            }
            if !self.isSandbox() {
                self.resolve(call, [
                    "ok": true,
                    "skipped": true,
                    "message": "Mock Reader is sandbox-only; production uses a physical Square Reader.",
                    "sandbox": false
                ])
                return
            }
            if let mockErr = self.ensureSandboxMockReader(from: presenter) {
                self.resolve(call, [
                    "ok": false,
                    "reason": "sandbox_mock_reader_required",
                    "message": mockErr,
                    "sdkLinked": true,
                    "sandbox": true
                ])
                return
            }
            self.resolve(call, ["ok": true, "sdkLinked": true, "sandbox": true, "mockReaderPresented": true])
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
                    var fields = self.squareErrorFields(error, prefix: "Square settings failed")
                    fields["ok"] = false
                    self.resolve(call, fields)
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
        let ns = error as NSError
        var codeName = "NSError"
        var debug = error.localizedDescription
        if let pay = PaymentError(rawValue: ns.code) {
            codeName = String(describing: pay)
        }
        if let info = ns.userInfo["SQErrorDebugCode"] as? String, !info.isEmpty {
            debug = info
            codeName = info
        } else if let info = ns.userInfo["debugCode"] as? String, !info.isEmpty {
            debug = info
            codeName = info
        } else if let info = ns.userInfo[NSLocalizedFailureReasonErrorKey] as? String, !info.isEmpty {
            debug = info
        }
        NSLog("FloorSquare payment failed: code=\(ns.code) name=\(codeName) debug=\(debug) userInfo=\(ns.userInfo)")
        finish([
            "ok": false,
            "reason": codeName,
            "code": ns.code,
            "message": "Square payment failed [\(codeName)]: \(debug)",
            "localizedDescription": error.localizedDescription,
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
