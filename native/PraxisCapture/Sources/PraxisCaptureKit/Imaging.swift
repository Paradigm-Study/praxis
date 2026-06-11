import AppKit
import CoreGraphics
import Foundation

/// PNG encoding for a CGImage.
func pngData(_ cg: CGImage) -> Data? {
    let rep = NSBitmapImageRep(cgImage: cg)
    return rep.representation(using: .png, properties: [:])
}

/// Render a string into an offscreen image — used by `--selftest-ocr` to prove
/// the Vision OCR path works without needing Screen Recording permission.
func renderTextImage(_ text: String, width: Int = 1040, height: Int = 140) -> CGImage? {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 30),
        .foregroundColor: NSColor.black,
    ]
    (text as NSString).draw(at: NSPoint(x: 18, y: 54), withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()
    return rep.cgImage
}
