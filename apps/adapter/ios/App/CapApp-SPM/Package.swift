// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.1"),
        .package(name: "CapacitorCommunitySqlite", path: "../../../../../node_modules/@capacitor-community/sqlite"),
        .package(name: "CapacitorCamera", path: "../../../../../node_modules/@capacitor/camera"),
        .package(name: "CapacitorFilesystem", path: "../../../../../node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorShare", path: "../../../../../node_modules/@capacitor/share"),
        .package(name: "FloorSquarePlugin", path: "../../../../../node_modules/@floor/square-plugin"),
        .package(url: "https://github.com/square/mobile-payments-sdk-ios", exact: "2.6.0"),
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorCommunitySqlite", package: "CapacitorCommunitySqlite"),
                .product(name: "CapacitorCamera", package: "CapacitorCamera"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "FloorSquarePlugin", package: "FloorSquarePlugin"),
                .product(name: "SquareMobilePaymentsSDK", package: "mobile-payments-sdk-ios"),
                .product(name: "MockReaderUI", package: "mobile-payments-sdk-ios"),
            ]
        )
    ]
)
