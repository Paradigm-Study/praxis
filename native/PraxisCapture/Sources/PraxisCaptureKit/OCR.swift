import Vision
import CoreGraphics

/// On-device OCR via the macOS Vision framework (no network, no dependencies).
/// Screen frames are OCR'd at capture time so the reconstructor and observer get
/// the *visible text* as real evidence — not just an opaque image blob.
enum OCR {
    static func recognize(_ cgImage: CGImage) -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        // Multilingual screens are normal (code-switching users, Chinese docs
        // beside English code). Vision detects the language per region; the
        // list is priority hints, not a restriction.
        request.automaticallyDetectsLanguage = true
        request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"]

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            log("OCR failed: \(error)")
            return []
        }
        guard let results = request.results else { return [] }
        return results.prefix(200).compactMap { $0.topCandidates(1).first?.string }
    }
}
