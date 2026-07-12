import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import UserNotifications
import PraxisCaptureKit

/// Diagnostics to stderr (→ the LaunchAgent's launchd.log) AND to a log file —
/// stderr is discarded when the app is launched via `open`/Finder, which made
/// notification-delivery failures undiagnosable.
let barLogURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/praxis-bar.log")
func barLog(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[praxis-bar] \(ts) \(msg)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    if let data = line.data(using: .utf8) {
        if let fh = try? FileHandle(forWritingTo: barLogURL) {
            defer { try? fh.close() }
            _ = try? fh.seekToEnd()
            try? fh.write(contentsOf: data)
        } else {
            try? data.write(to: barLogURL)
        }
    }
}

/// Praxis menu-bar app. A small launcher/dashboard for the Praxis pipeline:
/// start/stop live capture + the agent loop, open the Studio, run the AI proxy,
/// request the macOS permissions the native taps need, and build the native
/// client — all from the menu bar. It spawns the existing `praxis` Node CLI as
/// child processes, so the bar app is the one launcher you keep running.
final class PraxisBar: NSObject, NSApplicationDelegate, NSMenuDelegate,
    UNUserNotificationCenterDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let home: String
    private let studioPort = 4319
    private let proxyPort = 4318

    // Capture runs the native taps IN-PROCESS (so screen/AX execute under THIS
    // app's granted TCC identity) and pipes the NDJSON into the node pipeline.
    private var captureRunner: CaptureRunner?
    private var capturePipeline: Process?
    private var studio: Process?
    private var proxy: Process?

    private var captureRunning: Bool { captureRunner != nil && running(capturePipeline) }

    // Audio is opt-in per channel and persisted; only on-device transcripts are
    // emitted, never raw audio.
    private var audioSystem: Bool {
        get { UserDefaults.standard.bool(forKey: "audioSystem") }
        set { UserDefaults.standard.set(newValue, forKey: "audioSystem") }
    }
    private var audioMic: Bool {
        get { UserDefaults.standard.bool(forKey: "audioMic") }
        set { UserDefaults.standard.set(newValue, forKey: "audioMic") }
    }

    override init() {
        home = PraxisBar.resolveHome()
        super.init()
    }

    // Retained so the signal source keeps firing for the app's lifetime.
    private var termSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_: Notification) {
        // Singleton: launchd's instance and an `open`ed instance must not race
        // (two bars = two capture pipelines writing the same DB).
        let bundleId = Bundle.main.bundleIdentifier ?? "com.paradigm.praxis"
        let twins = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !twins.isEmpty {
            barLog("another Praxis instance is already running (pid \(twins[0].processIdentifier)) — exiting")
            exit(0)
        }

        // SIGTERM (pkill, logout, launchd unload) must run the SAME cleanup as
        // Quit — a plain SIGTERM death orphans the capture pipeline, and every
        // orphan is another agent loop contending on the DB.
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { [weak self] in
            barLog("SIGTERM — cleaning up children before exit")
            self?.quit()
        }
        src.resume()
        termSource = src

        let ax = AXIsProcessTrusted()
        let scr = CGPreflightScreenCaptureAccess()
        FileHandle.standardError.write(
            "PraxisBar ready; home=\(home.isEmpty ? "<not found>" : home); "
            .appending("accessibility=\(ax) screenRecording=\(scr)\n").data(using: .utf8)!)
        NSApp.setActivationPolicy(.accessory)
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "eye.circle", accessibilityDescription: "Praxis")
            button.image?.isTemplate = true
        }
        menu.delegate = self
        statusItem.menu = menu
        rebuildMenu()

        // Native notifications for the agent's proactive questions — posted by
        // THIS signed app (reliable), unlike osascript from a background process.
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            barLog("notif auth: granted=\(granted) error=\(String(describing: error))")
        }
        center.getNotificationSettings { s in
            barLog("notif settings: status=\(s.authorizationStatus.rawValue) alert=\(s.alertSetting.rawValue)")
        }
        // Praxis-owned question surface — immune to the system-notification
        // failure modes (Focus/DND, screen sharing, missed banners).
        QuestionPanel.shared.onAnswer = { [weak self] q, answer in
            self?.submitAnswer(questionId: q.id, question: q.question, answer: answer)
            UNUserNotificationCenter.current()
                .removeDeliveredNotifications(withIdentifiers: [q.id])
            barLog("panel answer for \(q.id): \(answer.prefix(40))")
        }
        QuestionPanel.shared.onQueueChange = { [weak self] count in
            self?.statusItem.button?.title = count > 0 ? " \(count)" : ""
        }
        startQuestionWatcher()

        // Always-on by design: if Praxis is already permitted, start capturing
        // automatically so it survives restarts without a manual click.
        if !home.isEmpty && ax && scr {
            startCapture()
            rebuildMenu()
        }
    }

    // MARK: - Proactive question notifications

    private var questionOffset: UInt64 = 0
    private var questionTimer: Timer?
    // categoryId -> the question it belongs to, so a tapped action maps to an answer.
    private struct PendingQuestion { let id: String; let question: String; let options: [String] }
    private var pendingQuestions: [String: PendingQuestion] = [:]
    private var registeredCategories: [String: UNNotificationCategory] = [:]

    private var questionFile: String { home + "/data/notifications.ndjson" }

    private func startQuestionWatcher() {
        guard !home.isEmpty else { return }
        questionOffset = fileSize(questionFile) // skip the backlog; only new asks
        questionTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.drainQuestions()
        }
    }

    private func fileSize(_ path: String) -> UInt64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let n = attrs[.size] as? NSNumber else { return 0 }
        return n.uint64Value
    }

    private func drainQuestions() {
        let size = fileSize(questionFile)
        guard size > questionOffset, let fh = FileHandle(forReadingAtPath: questionFile) else {
            if size < questionOffset { questionOffset = size } // file was truncated/reset
            return
        }
        defer { try? fh.close() }
        try? fh.seek(toOffset: questionOffset)
        let data = fh.readDataToEndOfFile()
        questionOffset = size
        guard let text = String(data: data, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let msg = obj["message"] as? String, !msg.isEmpty else { continue }
            let id = (obj["id"] as? String) ?? UUID().uuidString
            let options = (obj["options"] as? [String]) ?? []
            postQuestion(id: id, question: msg, options: options)
        }
    }

    private func postQuestion(id: String, question: String, options: [String]) {
        let categoryId = "praxis_q_\(id)"
        var actions: [UNNotificationAction] = []
        for (i, opt) in options.prefix(3).enumerated() {
            actions.append(UNNotificationAction(identifier: "opt_\(i)", title: opt, options: []))
        }
        actions.append(UNTextInputNotificationAction(
            identifier: "opt_text", title: "Other…", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "Type your own answer"))

        let category = UNNotificationCategory(
            identifier: categoryId, actions: actions, intentIdentifiers: [], options: [])
        registeredCategories[categoryId] = category
        pendingQuestions[categoryId] = PendingQuestion(id: id, question: question, options: options)
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories(Set(registeredCategories.values))

        let content = UNMutableNotificationContent()
        content.title = "Praxis — quick check"
        content.body = question
        content.sound = .default
        content.categoryIdentifier = categoryId
        content.userInfo = ["studio": "http://localhost:\(studioPort)/#questions"]
        let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        barLog("posting question \(id): \(question.prefix(50))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            center.add(req) { error in barLog("notif add(\(id)): error=\(String(describing: error))") }
        }
        // Also surface it in the floating panel — the path macOS can't mute.
        QuestionPanel.shared.enqueue(.init(id: id, question: question, options: options))
    }

    /// Persist the user's answer via the Studio API (shared DB → the agent loop
    /// sees it and stops re-asking). Starts Studio if it isn't running.
    private func submitAnswer(questionId: String, question: String, answer: String) {
        if !running(studio) { studio = node("studio", ["--port=\(studioPort)"], log: "studio") }
        guard let url = URL(string: "http://localhost:\(studioPort)/api/answer") else { return }
        let body: [String: Any] = ["questionId": questionId, "question": question, "answer": answer]
        func post(_ attempt: Int) {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            if let token = ProcessInfo.processInfo.environment["PRAXIS_LOCAL_TOKEN"] {
                req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                if !ok && attempt < 6 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { post(attempt + 1) }
                }
            }.resume()
        }
        post(0)
    }

    // Present the banner even though we're an accessory app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    // A chosen option / typed reply becomes the answer; tapping the body opens
    // the Studio question card.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        let categoryId = content.categoryIdentifier
        let pending = pendingQuestions[categoryId]
        let actionId = response.actionIdentifier
        var answer: String?
        if actionId == "opt_text", let textResp = response as? UNTextInputNotificationResponse {
            answer = textResp.userText
        } else if actionId.hasPrefix("opt_"), let idx = Int(actionId.dropFirst(4)),
                  let opts = pending?.options, idx < opts.count {
            answer = opts[idx]
        }
        DispatchQueue.main.async {
            if let answer, !answer.isEmpty, let p = pending {
                self.submitAnswer(questionId: p.id, question: p.question, answer: answer)
                self.pendingQuestions[categoryId] = nil
                self.registeredCategories[categoryId] = nil
                QuestionPanel.shared.retract(id: p.id)
            } else {
                self.openStudioQuestions()
            }
            completionHandler()
        }
    }

    private func openStudioQuestions() {
        if !running(studio) { studio = node("studio", ["--port=\(studioPort)"], log: "studio") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if let url = URL(string: "http://localhost:\(self.studioPort)/#questions") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func applicationWillTerminate(_: Notification) {
        captureRunner?.stop()
        for p in [capturePipeline, studio, proxy] { p?.terminate() }
    }

    // MARK: - Menu

    func menuWillOpen(_: NSMenu) { rebuildMenu() }

    private func rebuildMenu() {
        menu.removeAllItems()
        let cap = captureRunning, stu = running(studio), prx = running(proxy)
        let scr = CGPreflightScreenCaptureAccess()
        let ax = AXIsProcessTrusted()

        header(home.isEmpty ? "Praxis — project not found" : "Praxis")
        if home.isEmpty {
            info("Set PRAXIS_HOME to your praxis/ folder")
        } else {
            info("\(dot(cap)) Capture    \(dot(stu)) Studio    \(dot(prx)) Proxy")
        }
        menu.addItem(.separator())

        item(cap ? "Stop Capture" : "Start Capture  (native + agent)",
             #selector(toggleCapture), key: "c")
        item("Open Studio", #selector(openStudio), key: "s")
        item(prx ? "Stop AI Proxy" : "Start AI Proxy", #selector(toggleProxy), key: "p")
        menu.addItem(.separator())

        info("Audio (on-device transcripts only, never raw audio):")
        let sys = item("System Audio  (what's playing)", #selector(toggleAudioSystem))
        sys.state = audioSystem ? .on : .off
        let mic = item("Microphone  (meetings, dictation)", #selector(toggleAudioMic))
        mic.state = audioMic ? .on : .off
        menu.addItem(.separator())

        info("Permissions:  \(check(scr)) Screen    \(check(ax)) Accessibility")
        item("Request Screen Recording…", #selector(requestScreen))
        item("Request Accessibility…", #selector(requestAccessibility))
        item("Open Privacy Settings…", #selector(openPrivacy))
        menu.addItem(.separator())

        item("Build Native Client", #selector(buildNative))
        item("Reveal Data Folder", #selector(revealData))
        item("View Logs", #selector(revealLogs))
        menu.addItem(.separator())
        item("Quit Praxis", #selector(quit), key: "q")
    }

    // MARK: - Actions

    @objc private func toggleCapture() {
        if captureRunning { stopCapture() } else { startCapture() }
        rebuildMenu()
    }

    @objc private func toggleAudioSystem() {
        audioSystem.toggle()
        captureRunner?.setAudio(system: audioSystem, mic: audioMic)
        rebuildMenu()
    }

    @objc private func toggleAudioMic() {
        audioMic.toggle()
        captureRunner?.setAudio(system: audioSystem, mic: audioMic)
        rebuildMenu()
    }

    @objc private func openStudio() {
        if !running(studio) { studio = node("studio", ["--port=\(studioPort)"], log: "studio") }
        openStudioWhenReady()
        rebuildMenu()
    }

    /// Poll the Studio until it actually answers, then open the browser — avoids
    /// racing the server's startup with a fixed delay.
    private func openStudioWhenReady(attempt: Int = 0) {
        let probe = URL(string: "http://localhost:\(studioPort)/api/status")!
        var req = URLRequest(url: probe)
        req.timeoutInterval = 0.5
        if let token = ProcessInfo.processInfo.environment["PRAXIS_LOCAL_TOKEN"] {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            guard let self else { return }
            let ready = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if ready || attempt > 16 {
                    NSWorkspace.shared.open(URL(string: "http://localhost:\(self.studioPort)")!)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.openStudioWhenReady(attempt: attempt + 1)
                    }
                }
            }
        }.resume()
    }

    @objc private func toggleProxy() {
        if running(proxy) { stop(&proxy) }
        else { proxy = node("proxy", ["--enable", "--port=\(proxyPort)"], log: "proxy") }
        rebuildMenu()
    }

    @objc private func requestScreen() {
        CGRequestScreenCaptureAccess()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.rebuildMenu() }
    }

    @objc private func requestAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.rebuildMenu() }
    }

    @objc private func openPrivacy() {
        NSWorkspace.shared.open(URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    @objc private func buildNative() {
        let p = launch(["/usr/bin/env", "swift", "build", "--package-path", "native/PraxisCapture"],
                       log: "build")
        p?.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                self?.notify(proc.terminationStatus == 0
                    ? "Native client built ✓" : "Build failed — see View Logs")
            }
        }
    }

    @objc private func revealData() { reveal("data") }
    @objc private func revealLogs() { reveal("data/logs") }

    @objc private func quit() {
        captureRunner?.stop()
        for p in [capturePipeline, studio, proxy] { p?.terminate() }
        NSApp.terminate(nil)
    }

    // MARK: - Process management

    private func running(_ p: Process?) -> Bool { p?.isRunning == true }
    private func stop(_ p: inout Process?) { p?.terminate(); p = nil }

    private func stopCapture() {
        captureRunner?.stop(); captureRunner = nil
        capturePipeline?.terminate(); capturePipeline = nil
    }

    /// Start live capture:
    ///   CaptureRunner (IN-PROCESS — runs under THIS app's granted TCC identity)
    ///        │ NDJSON
    ///        ▼ stdin
    ///   node … capture --native-stdin --agent   (reconstruct/fuse/observe)
    private func startCapture() {
        guard !home.isEmpty else { _ = projectMissing(); return }

        let pipeline = Process()
        // --observer=anthropic: the loop learns a real model of how you work
        // (decisions/know-how) and asks when it's unsure — throttled for cost.
        let argv = nodeArgv("capture", ["--native-stdin", "--agent", "--observer=anthropic"])
        pipeline.executableURL = URL(fileURLWithPath: argv[0])
        pipeline.arguments = Array(argv.dropFirst())
        pipeline.currentDirectoryURL = URL(fileURLWithPath: home)
        pipeline.environment = baseEnv()
        let bridge = Pipe()
        pipeline.standardInput = bridge
        if let clog = logHandle("capture") {
            pipeline.standardOutput = clog
            pipeline.standardError = clog
        }
        pipeline.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.rebuildMenu() }
        }
        do {
            try pipeline.run()
        } catch {
            notify("Failed to start the capture pipeline: \(error.localizedDescription)")
            return
        }
        capturePipeline = pipeline

        // Taps run here, in the granted app, emitting into the node pipeline.
        let policy = NativePolicyGate(
            path: home + "/data/native-acquisition-policy.json",
            mode: .required
        )
        let runner = CaptureRunner(options: CaptureOptions(
            audioSystem: audioSystem, audioMic: audioMic), policy: policy)
        let state = runner.start(output: bridge.fileHandleForWriting)
        captureRunner = runner

        if !state.accessibility || !state.screenRecording {
            notify("""
            Capture started, but macOS hasn't granted Praxis everything yet:
              Screen Recording: \(state.screenRecording ? "✓" : "✗")
              Accessibility:    \(state.accessibility ? "✓" : "✗")
            Use the Request… buttons / System Settings, then Stop + Start Capture.
            """)
        }
    }

    private func nodeArgv(_ cmd: String, _ extra: [String]) -> [String] {
        let prefix: [String]
        if let nodeBin = ProcessInfo.processInfo.environment["PRAXIS_NODE"] {
            prefix = [nodeBin]
        } else {
            prefix = ["/usr/bin/env", "node"]
        }
        return prefix + ["--disable-warning=ExperimentalWarning", "src/cli/praxis.ts", cmd] + extra
    }

    private func baseEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        env["PATH"] = (([env["PATH"]].compactMap { $0 }) + extra).joined(separator: ":")
        // Cost-appropriate model for all-day observation (override via env).
        if env["PRAXIS_OBSERVER_MODEL"] == nil { env["PRAXIS_OBSERVER_MODEL"] = "claude-sonnet-4-6" }
        return env
    }

    private func logHandle(_ name: String) -> FileHandle? {
        let dir = home + "/data/logs"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let url = URL(fileURLWithPath: "\(dir)/\(name).log")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        return try? FileHandle(forWritingTo: url)
    }

    /// Spawn `node praxis.ts <cmd> <extra…>` from the project root.
    private func node(_ cmd: String, _ extra: [String], log: String) -> Process? {
        guard !home.isEmpty else { return projectMissing() }
        return launch(nodeArgv(cmd, extra), log: log)
    }

    private func launch(_ argv: [String], log: String) -> Process? {
        guard !home.isEmpty else { return projectMissing() }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        p.currentDirectoryURL = URL(fileURLWithPath: home)

        // Make node/swift resolvable when launched outside a login shell.
        var env = ProcessInfo.processInfo.environment
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        env["PATH"] = (([env["PATH"]].compactMap { $0 }) + extra).joined(separator: ":")

        // Inside the packaged Praxis.app, the capture binary ships next to the
        // bar executable — point the pipeline at it so the spawned tree keeps
        // the signed app's TCC identity (no swift toolchain needed at runtime).
        if let exe = Bundle.main.executablePath {
            let bundled = (exe as NSString).deletingLastPathComponent + "/praxis-capture"
            if FileManager.default.isExecutableFile(atPath: bundled) {
                env["PRAXIS_NATIVE_BIN"] = bundled
            }
        }
        p.environment = env

        let dir = home + "/data/logs"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let logURL = URL(fileURLWithPath: "\(dir)/\(log).log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = fh
            p.standardError = fh
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.rebuildMenu() }
        }
        do { try p.run() } catch {
            notify("Failed to start \(argv.first ?? ""): \(error.localizedDescription)")
            return nil
        }
        return p
    }

    private func projectMissing() -> Process? {
        notify("Praxis project not found. Launch from the repo or set PRAXIS_HOME.")
        return nil
    }

    private func reveal(_ rel: String) {
        guard !home.isEmpty else { _ = projectMissing(); return }
        let path = home + "/" + rel
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    // MARK: - Menu builders

    @discardableResult
    private func item(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        it.target = self
        menu.addItem(it)
        return it
    }

    private func info(_ title: String) {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.isEnabled = false
        menu.addItem(it)
    }

    private func header(_ title: String) {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.isEnabled = false
        it.attributedTitle = NSAttributedString(
            string: title, attributes: [.font: NSFont.boldSystemFont(ofSize: 12)])
        menu.addItem(it)
    }

    private func dot(_ on: Bool) -> String { on ? "🟢" : "⚪️" }
    private func check(_ ok: Bool) -> String { ok ? "✓" : "✗" }

    private func notify(_ msg: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Praxis"
        a.informativeText = msg
        a.runModal()
    }

    // MARK: - Project resolution

    private static func resolveHome() -> String {
        let fm = FileManager.default
        let marker = "/src/cli/praxis.ts"
        func climb(_ start: String) -> String? {
            var dir = start
            for _ in 0..<10 {
                if fm.fileExists(atPath: dir + marker) { return dir }
                let parent = (dir as NSString).deletingLastPathComponent
                if parent == dir { break }
                dir = parent
            }
            return nil
        }
        if let h = ProcessInfo.processInfo.environment["PRAXIS_HOME"],
           fm.fileExists(atPath: h + marker) { return h }
        if let h = climb(fm.currentDirectoryPath) { return h }
        let exe = (CommandLine.arguments.first as NSString?)?.resolvingSymlinksInPath
        if let exe, let h = climb((exe as NSString).deletingLastPathComponent) { return h }
        return ""
    }
}

let app = NSApplication.shared
let delegate = PraxisBar()
app.delegate = delegate
app.run()
