import Foundation

/// Pure desired-state machine for an asynchronously starting audio tap.
///
/// The owner must mutate this value under the same lock that protects its
/// concrete stream. That makes `completeStart` + stream installation atomic
/// with `cancel` + stream removal: a tap disabled while ScreenCaptureKit is
/// awaiting permission/content can never come back later as an orphan.
public struct AudioTapLifecycle {
    public private(set) var desired = false
    public private(set) var starting = false
    public private(set) var running = false
    public private(set) var failureCount = 0

    private var generation: UInt64 = 0
    private var retryNotBefore: TimeInterval = 0

    public init() {}

    /// Returns a generation token when a new start attempt is allowed.
    public mutating func requestStart(now: TimeInterval) -> UInt64? {
        desired = true
        guard !starting, !running, now >= retryNotBefore else { return nil }
        generation &+= 1
        starting = true
        return generation
    }

    public func acceptsStart(_ token: UInt64) -> Bool {
        desired && starting && generation == token
    }

    /// Completes one start attempt. `true` means the owner may atomically
    /// install the newly started stream while it still holds its state lock.
    @discardableResult
    public mutating func completeStart(
        _ token: UInt64,
        succeeded: Bool,
        now: TimeInterval,
        retryBase: TimeInterval = 1,
        retryMax: TimeInterval = 30
    ) -> Bool {
        guard acceptsStart(token) else { return false }
        starting = false
        if succeeded {
            running = true
            failureCount = 0
            retryNotBefore = 0
            return true
        }
        running = false
        recordFailure(now: now, retryBase: retryBase, retryMax: retryMax)
        return false
    }

    /// Records an unexpected stop for the currently installed stream.
    public mutating func stoppedUnexpectedly(
        now: TimeInterval,
        retryBase: TimeInterval = 1,
        retryMax: TimeInterval = 30
    ) {
        guard desired, running else { return }
        running = false
        generation &+= 1
        recordFailure(now: now, retryBase: retryBase, retryMax: retryMax)
    }

    /// Invalidates every pending generation immediately.
    public mutating func cancel() {
        desired = false
        starting = false
        running = false
        failureCount = 0
        retryNotBefore = 0
        generation &+= 1
    }

    private mutating func recordFailure(
        now: TimeInterval,
        retryBase: TimeInterval,
        retryMax: TimeInterval
    ) {
        let base = max(0.1, retryBase)
        let cap = max(base, retryMax)
        let exponent = min(20, failureCount)
        let delay = min(cap, base * pow(2, Double(exponent)))
        failureCount += 1
        retryNotBefore = now + delay
    }
}
