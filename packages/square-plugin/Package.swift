// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FloorSquarePlugin",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "FloorSquarePlugin", targets: ["FloorSquarePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/square/mobile-payments-sdk-ios", exact: "2.6.0")
    ],
    targets: [
        .target(
            name: "FloorSquarePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "SquareMobilePaymentsSDK", package: "mobile-payments-sdk-ios")
                // MockReaderUI is NOT a plugin dependency. Square packages it as APPL
                // (bundle id com.squareup.readersdk.mockreaderui), which App Store Connect
                // rejects. CapApp-SPM optionally links it for ad-hoc sandbox builds only;
                // Swift uses #if canImport(MockReaderUI). See docs/SQUARE.md.
            ],
            path: "ios/Sources/FloorSquarePlugin"
        )
    ]
)
