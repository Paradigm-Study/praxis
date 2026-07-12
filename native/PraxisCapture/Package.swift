// swift-tools-version:6.0
// Every target pins Swift 5 language mode so compile semantics remain stable.
import PackageDescription

let package = Package(
    name: "PraxisCapture",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "praxis-capture", targets: ["PraxisCaptureCLI"]),
        // Library so the menu-bar app can run the taps IN-PROCESS — that keeps
        // capture under the granted app's TCC identity (ad-hoc nested binaries
        // do not inherit the app's permissions).
        .library(name: "PraxisCaptureKit", targets: ["PraxisCaptureKit"]),
    ],
    targets: [
        .target(
            name: "PraxisCaptureKit",
            path: "Sources/PraxisCaptureKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "PraxisCaptureCLI",
            dependencies: ["PraxisCaptureKit"],
            path: "Sources/PraxisCapture",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Pure headless self-check (this standalone Swift toolchain ships
        // neither XCTest nor swift-testing). Runtime capture still requires
        // Screen Recording TCC and is intentionally not exercised here.
        .executableTarget(
            name: "ClipRingSelfTest",
            dependencies: ["PraxisCaptureKit"],
            path: "Tests/PraxisCaptureKitTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
