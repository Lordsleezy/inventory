// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FloorSquarePlugin",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "FloorSquarePlugin", targets: ["FloorSquarePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.1")
    ],
    targets: [
        .target(
            name: "FloorSquarePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ]
        )
    ]
)
