import UIKit
import Capacitor
import SquareMobilePaymentsSDK

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private static var didInitSquare = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Square docs: initialize in didFinishLaunchingWithOptions with launchOptions + Application ID.
        // FloorSquarePlugin.load() is a fallback if CapApp-SPM loads before this runs.
        Self.bootstrapSquare(launchOptions: launchOptions)
        return true
    }

    static func bootstrapSquare(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        guard !didInitSquare else { return }
        let appId = (Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String) ?? ""
        guard !appId.isEmpty, appId != "REPLACE_ME" else {
            NSLog("FloorSquare AppDelegate: SquareApplicationID missing — skip initialize")
            return
        }
        MobilePaymentsSDK.initialize(applicationLaunchOptions: launchOptions, squareApplicationID: appId)
        didInitSquare = true
        NSLog("FloorSquare AppDelegate: MobilePaymentsSDK.initialize appIdPrefix=%@", String(appId.prefix(24)))
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
