// swift-tools-version: 5.10.1

import PackageDescription

let package = Package(
    name: "openloop",
    platforms: [
        .macOS(.v14),
        .iOS(.v16),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-system", from: "1.6.1"),
        .package(url: "https://github.com/swiftlang/swift-subprocess", branch: "main"),
        .package(url: "https://github.com/genkernel/llm-graph", branch: "main"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.2.0"),
        .package(
            url: "https://github.com/apple/swift-crypto",
            "3.0.0" ..< "5.0.0"
        ),
        .package(url: "https://github.com/vapor/vapor", from: "4.121.3"),
        .package(url: "https://github.com/stephencelis/SQLite.swift", from: "0.15.3"),
    ],

    targets: [
    .target(
        name: "shared",
        dependencies: [
            .product(name: "SystemPackage", package: "swift-system"),
            .product(name: "Subprocess", package: "swift-subprocess"),
            .product(name: "Crypto", package: "swift-crypto"),
            .product(name: "ArgumentParser", package: "swift-argument-parser"),
            .product(name: "Vapor", package: "vapor"),
            .product(name: "SQLite", package: "SQLite.swift"),
        ]
    ),
        .executableTarget(
            name: "openloop",
            dependencies: [
                "shared",
            ]
        ),
        .executableTarget(
            name: "runner",
//            outputName: "openloop-runner",
            dependencies: [
                "shared",
                .product(name: "LLMGraph", package: "llm-graph"),
            ]
        ),
        .executableTarget(
            name: "api",
            dependencies: [
                "shared",
                .product(name: "Vapor", package: "vapor"),
            ],
            resources: [
                .copy("Public"),
                .process("Public/styles.css"),
                .process("Public/app.js"),
                .process("Public/index.html"),
            ]
        ),
        .executableTarget(
            name: "w2",
            dependencies: [
                "shared",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "SystemPackage", package: "swift-system"),
            ]
        ),
    ]
)
