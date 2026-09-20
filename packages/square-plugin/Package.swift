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
        // Square Mobile Payments SDK — resolved by CapApp-SPM via this plugin; no manual Xcode SPM step.
        .package(url: "https://github.com/square/mobile-payments-sdk-ios", exact: "2.6.0")
    ],
    targets: [
        .target(
            name: "FloorSquarePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "SquareMobilePaymentsSDK", package: "mobile-payments-sdk-ios")
            ],
            path: "ios/Sources/FloorSquarePlugin"
        )
    ]
)
