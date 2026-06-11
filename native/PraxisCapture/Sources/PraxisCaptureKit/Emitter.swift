import Foundation

/// Emits normalized raw events as NDJSON on stdout — one JSON object per line —
/// matching the wire format the TypeScript `NativeCaptureSource` bridge expects:
///   { ts, source, app, window, type, payload, blobFiles?: [{kind, path}] }
/// Large binary data (screen frames) is written to a temp file and referenced
/// via `blobFiles`; the bridge reads + deletes it.
final class Emitter {
    static let shared = Emitter()

    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    let blobDir: URL

    /// Where NDJSON goes. Defaults to stdout (standalone client); the menu-bar
    /// app points this at the node pipeline's stdin when it runs taps in-process.
    var output: FileHandle = .standardOutput
    /// Serializes writes — taps fire from the main run loop AND from the screen
    /// capture's async Task, so unguarded writes could interleave lines.
    private let lock = NSLock()

    init() {
        blobDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("praxis-frames", isDirectory: true)
        try? FileManager.default.createDirectory(at: blobDir, withIntermediateDirectories: true)
    }

    func emit(source: String, app: String, window: String, type: String,
              payload: [String: Any] = [:], blobFiles: [[String: String]]? = nil) {
        var obj: [String: Any] = [
            "ts": iso.string(from: Date()),
            "source": source,
            "app": app,
            "window": window,
            "type": type,
            "payload": payload,
        ]
        if let blobFiles { obj["blobFiles"] = blobFiles }
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        guard let bytes = line.data(using: .utf8) else { return }
        lock.lock()
        defer { lock.unlock() }
        output.write(bytes)
    }

    /// Write bytes to a temp blob file and return the blobFiles entry.
    func writeBlob(_ data: Data, kind: String, ext: String) -> [String: String]? {
        let name = UUID().uuidString + "." + ext
        let url = blobDir.appendingPathComponent(name)
        do {
            try data.write(to: url)
            return ["kind": kind, "path": url.path]
        } catch {
            log("blob write failed: \(error)")
            return nil
        }
    }
}

/// Diagnostics go to stderr so they never corrupt the NDJSON stream on stdout.
func log(_ msg: String) {
    FileHandle.standardError.write(("[praxis-capture] " + msg + "\n").data(using: .utf8)!)
}
