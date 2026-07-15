import Darwin
import Foundation

/// Owner-only staging and publication for blobs referenced over the native
/// NDJSON bridge. A blob is never announced until its final path is a regular,
/// single-link 0600 file inside the already-secured 0700 directory.
public enum NativeBlobFileSecurity {
    private static let publishedNamePattern =
        #"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\.(png|mp4|txt|m4a|wav|caf)$"#

    public static func prepareDirectory(at url: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
        var info = stat()
        guard lstat(url.path, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              info.st_uid == geteuid() else {
            throw posixError("unsafe native blob directory", path: url.path)
        }
        guard chmod(url.path, 0o700) == 0 else {
            throw posixError("could not secure native blob directory", path: url.path)
        }
        var secured = stat()
        guard lstat(url.path, &secured) == 0,
              sameFile(info, secured),
              (secured.st_mode & 0o077) == 0 else {
            throw posixError("native blob directory permissions changed", path: url.path)
        }
    }

    public static func atomicWrite(_ data: Data, to finalURL: URL) throws {
        let directory = finalURL.deletingLastPathComponent()
        try prepareDirectory(at: directory)
        guard isPublishedBlobName(finalURL.lastPathComponent) else {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        let stagingURL = directory.appendingPathComponent(
            ".praxis-\(UUID().uuidString).staging",
            isDirectory: false
        )
        defer { try? FileManager.default.removeItem(at: stagingURL) }
        try data.write(to: stagingURL, options: [.atomic])
        try publishStagedFile(at: stagingURL, to: finalURL)
    }

    /// Atomically publish a completed producer file such as an AVAssetWriter
    /// output. Both URLs must be direct children of the secured blob directory.
    public static func publishStagedFile(at stagingURL: URL, to finalURL: URL) throws {
        let directory = finalURL.deletingLastPathComponent().standardizedFileURL
        guard stagingURL.deletingLastPathComponent().standardizedFileURL == directory,
              isPublishedBlobName(finalURL.lastPathComponent) else {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        try prepareDirectory(at: directory)
        let staged = try secureRegularFile(at: stagingURL)
        do {
            try FileManager.default.moveItem(at: stagingURL, to: finalURL)
            let published = try secureRegularFile(at: finalURL)
            guard sameFile(staged, published) else {
                throw posixError("published native blob identity changed", path: finalURL.path)
            }
        } catch {
            removeFile(at: finalURL, onlyIfSameAs: staged)
            throw error
        }
    }

    /// Remove only old, producer-shaped, owner-owned, single-link regular
    /// files. Symlinks, hard links, directories, and recently emitted blobs are
    /// deliberately left untouched.
    @discardableResult
    public static func removeStaleOwnedBlobs(
        in directory: URL,
        olderThan age: TimeInterval,
        now: Date = Date()
    ) throws -> Int {
        try prepareDirectory(at: directory)
        let urls = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: []
        )
        var removed = 0
        for url in urls where isPublishedBlobName(url.lastPathComponent) {
            guard let before = ownedRegularFileStat(at: url, requirePrivateMode: false),
                  modificationDate(before).addingTimeInterval(age) <= now else { continue }
            var current = stat()
            guard lstat(url.path, &current) == 0,
                  sameFile(before, current),
                  ownedRegularFile(current),
                  unlink(url.path) == 0 else { continue }
            removed += 1
        }
        return removed
    }

    private static func secureRegularFile(at url: URL) throws -> stat {
        let flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK
        let descriptor = open(url.path, flags)
        guard descriptor >= 0 else {
            throw posixError("could not open native blob safely", path: url.path)
        }
        defer { close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, ownedRegularFile(before) else {
            throw posixError("unsafe native blob file", path: url.path)
        }
        guard fchmod(descriptor, 0o600) == 0 else {
            throw posixError("could not secure native blob file", path: url.path)
        }
        var secured = stat()
        guard fstat(descriptor, &secured) == 0,
              sameFile(before, secured),
              (secured.st_mode & 0o077) == 0 else {
            throw posixError("native blob file permissions changed", path: url.path)
        }
        return secured
    }

    private static func ownedRegularFileStat(
        at url: URL,
        requirePrivateMode: Bool
    ) -> stat? {
        var info = stat()
        guard lstat(url.path, &info) == 0,
              ownedRegularFile(info),
              !requirePrivateMode || (info.st_mode & 0o077) == 0 else { return nil }
        return info
    }

    private static func ownedRegularFile(_ info: stat) -> Bool {
        (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) &&
            info.st_uid == geteuid() && info.st_nlink == 1
    }

    private static func sameFile(_ lhs: stat, _ rhs: stat) -> Bool {
        lhs.st_dev == rhs.st_dev && lhs.st_ino == rhs.st_ino
    }

    private static func modificationDate(_ info: stat) -> Date {
        Date(
            timeIntervalSince1970: TimeInterval(info.st_mtimespec.tv_sec) +
                TimeInterval(info.st_mtimespec.tv_nsec) / 1_000_000_000
        )
    }

    private static func removeFile(at url: URL, onlyIfSameAs expected: stat) {
        var current = stat()
        guard lstat(url.path, &current) == 0,
              sameFile(expected, current),
              ownedRegularFile(current) else { return }
        _ = unlink(url.path)
    }

    private static func isPublishedBlobName(_ name: String) -> Bool {
        name.range(of: publishedNamePattern, options: .regularExpression) != nil
    }

    private static func posixError(_ message: String, path: String) -> NSError {
        NSError(
            domain: NSPOSIXErrorDomain,
            code: Int(errno),
            userInfo: [NSLocalizedDescriptionKey: "\(message): \(path)"]
        )
    }
}

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
        do {
            try NativeBlobFileSecurity.prepareDirectory(at: blobDir)
            try NativeBlobFileSecurity.removeStaleOwnedBlobs(
                in: blobDir,
                olderThan: 24 * 60 * 60
            )
        } catch {
            log("blob directory unavailable: \(error)")
        }
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
            try NativeBlobFileSecurity.atomicWrite(data, to: url)
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
