// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "T4Apple",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "T4Protocol", targets: ["T4Protocol"]),
        .library(name: "T4Client", targets: ["T4Client"]),
        .library(name: "T4Platform", targets: ["T4Platform"]),
        .library(name: "T4UI", targets: ["T4UI"]),
        .executable(name: "T4MacApp", targets: ["T4MacApp"]),
    ],
    targets: [
        .target(
            name: "T4Protocol"
        ),
        .target(
            name: "T4Client",
            dependencies: ["T4Protocol"]
        ),
        .target(
            name: "T4Platform",
            dependencies: ["T4Protocol"]
        ),
        .target(
            name: "T4UI",
            dependencies: ["T4Protocol", "T4Client", "T4Platform"]
        ),
        .executableTarget(
            name: "T4MacApp",
            dependencies: ["T4UI", "T4Client", "T4Platform"]
        ),
        .testTarget(
            name: "T4ProtocolTests",
            dependencies: ["T4Protocol"]
        ),
        .testTarget(
            name: "T4ClientTests",
            dependencies: ["T4Client", "T4Platform"]
        ),
    ]
)
