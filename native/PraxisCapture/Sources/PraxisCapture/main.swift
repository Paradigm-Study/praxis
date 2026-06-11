import Foundation
import PraxisCaptureKit

// Standalone Praxis native capture client. Thin wrapper over PraxisCaptureKit;
// the menu-bar app uses the same library in-process. Emits NDJSON on stdout.

func argValue(_ name: String, _ def: Double) -> Double {
    if let a = CommandLine.arguments.first(where: { $0.hasPrefix(name + "=") }) {
        return Double(a.dropFirst(name.count + 1)) ?? def
    }
    return def
}

if CommandLine.arguments.contains("--selftest-ocr") {
    exit(CaptureRunner.selftestOCR() ? 0 : 1)
}

let opts = CaptureOptions(
    frameInterval: argValue("--frame-interval", 3.0),
    axInterval: argValue("--ax-interval", 2.0),
    scrape: !CommandLine.arguments.contains("--no-scrape"),
    promptForScreen: !CommandLine.arguments.contains("--no-prompt"),
    audioSystem: CommandLine.arguments.contains("--audio-system"),
    audioMic: CommandLine.arguments.contains("--audio-mic")
)
let runner = CaptureRunner(options: opts)

if CommandLine.arguments.contains("--once") {
    runner.runOnce()
    exit(0)
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

runner.start()
RunLoop.main.run()
