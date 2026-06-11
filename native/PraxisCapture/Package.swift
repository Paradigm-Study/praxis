// swift-tools-version:5.9
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
        .target(name: "PraxisCaptureKit", path: "Sources/PraxisCaptureKit"),
        .executableTarget(
            name: "PraxisCaptureCLI",
            dependencies: ["PraxisCaptureKit"],
            path: "Sources/PraxisCapture"
        ),
    ]
)
