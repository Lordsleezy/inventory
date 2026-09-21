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
                .product(name: "SquareMobilePaymentsSDK", package: "mobile-payments-sdk-ios"),
                // Sandbox cannot use physical readers — MockReaderUI is required for TestFlight sandbox charges.
                // Pure Swift product from Square's SPM package (not Obj-C in this target).
                .product(name: "MockReaderUI", package: "mobile-payments-sdk-ios")
            ],
            path: "ios/Sources/FloorSquarePlugin"
        )
    ]
)
