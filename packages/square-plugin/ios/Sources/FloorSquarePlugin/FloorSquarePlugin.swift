import Capacitor
import Foundation

@objc(FloorSquarePlugin)
public class FloorSquarePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FloorSquarePlugin"
    public let jsName = "FloorSquare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "charge", returnType: CAPPluginReturnPromise)
    ]

    @objc func authorize(_ call: CAPPluginCall) {
        call.resolve(["ok": false, "reason": "square_sdk_not_linked"])
    }

    @objc func charge(_ call: CAPPluginCall) {
        call.reject("square_not_linked")
    }
}
