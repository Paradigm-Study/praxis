import Foundation
import PraxisCaptureKit

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), "ClipRing self-test failed: \(message)")
}

private func frame(_ ts: TimeInterval, byte: UInt8 = 0) -> ClipFrame {
    ClipFrame(data: Data([byte]), ts: ts)
}

var ring = ClipRing(capacity: 3)
for i in 0..<5 { ring.append(frame(Double(i))) }
expect(ring.orderedFrames.map(\.ts) == [2, 3, 4], "capacity keeps newest frames")
expect(ring.durationSeconds == 2, "duration uses oldest/newest timestamps")

var sparse = ClipRing(capacity: 360)
for i in 0...100 { sparse.append(frame(Double(i * 3))) }
sparse.removeFrames(olderThan: 210)
expect(sparse.orderedFrames.first?.ts == 210, "wall-clock trim removes old frames")
expect(sparse.orderedFrames.last?.ts == 300, "wall-clock trim retains newest frame")
expect(sparse.durationSeconds == 90, "sparse capture is bounded to 90 seconds")

let normalized = ClipMath.normalizeTimestamps([5, 5, 4, 6], minStep: 0.001)
expect(normalized.count == 4, "timestamp normalization preserves frame count")
for i in 1..<normalized.count {
    expect(normalized[i] > normalized[i - 1], "timestamps are strictly increasing")
}
expect(ClipMath.evenDimension(1921) == 1920, "odd video dimensions round down")

print("ClipRing self-test passed")
