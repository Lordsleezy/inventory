import UIKit
import Capacitor

#if canImport(SquareMobilePaymentsSDK)
import SquareMobilePaymentsSDK
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        #if canImport(SquareMobilePaymentsSDK)
        // Info.plist SquareApplicationID is set by scripts/ios-square-prepare.sh from SQUARE_APPLICATION_ID.
        if let appId = Bundle.main.object(forInfoDictionaryKey: "SquareApplicationID") as? String,
           !appId.isEmpty,
           appId != "REPLACE_ME" {
            MobilePaymentsSDK.initialize(squareApplicationID: appId)
        }
        #endif
        return true
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
