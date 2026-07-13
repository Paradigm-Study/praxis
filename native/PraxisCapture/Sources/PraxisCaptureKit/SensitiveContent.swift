import Foundation

/// Conservative content-level fence for clipboard and Accessibility strings.
/// It intentionally favors omission over retaining a likely credential.
public enum SensitiveContentFilter {
    private static let patterns = [
        #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#,
        #"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"#,
        #"\b(?:sk|gh[op]|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b"#,
        #"\bAKIA[0-9A-Z]{16}\b"#,
        #"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#,
        #"(?i)(?:password|passphrase|secret|token|api[_ -]?key|client[_ -]?secret|recovery[_ -]?code)\s*[:=]\s*[^\s]{6,}"#,
    ]

    public static func looksSensitive(_ value: String) -> Bool {
        for pattern in patterns where value.range(of: pattern, options: .regularExpression) != nil {
            return true
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 32, trimmed.count <= 4096,
              trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              trimmed.rangeOfCharacter(from: .letters) != nil,
              trimmed.rangeOfCharacter(from: .decimalDigits) != nil else { return false }
        return trimmed.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || "+/=_~.-".unicodeScalars.contains($0)
        }
    }
}
