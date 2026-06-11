// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PraxisBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "praxis-bar", targets: ["PraxisBar"])
    ],
    dependencies: [
        // Run the capture taps IN-PROCESS so they execute under this app's
        // (granted) TCC identity rather than a separate ad-hoc helper binary.
        .package(path: "../PraxisCapture")
    ],
    targets: [
        .executableTarget(
            name: "PraxisBar",
            dependencies: [.product(name: "PraxisCaptureKit", package: "PraxisCapture")],
            path: "Sources/PraxisBar"
        )
    ]
)
