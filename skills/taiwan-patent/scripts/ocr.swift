import Foundation
import Vision
import AppKit

// Usage: swift ocr.swift <image> [<image>...]
// Accurate OCR for TIPO scanned announcement pages (zh-Hant + en).

let paths = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") }
guard !paths.isEmpty else {
    fputs("usage: swift ocr.swift <image>...\n", stderr)
    exit(1)
}

func ocrImage(_ path: String) -> String? {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return nil
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return "OCR_FAILED: \(error)"
    }
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

for path in paths {
    print("===== \(path) =====")
    print(ocrImage(path) ?? "FAILED")
}
