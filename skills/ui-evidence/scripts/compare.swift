// Usage: compare OUT LEFT.png "Left title" "left note" RIGHT.png "Right title" "right note" [--box x,y,w,h] [--line y]
// Builds a labeled before/after image. --box outlines a region of LEFT in red;
// --line draws a dashed green marker across RIGHT at y (image pixels).
import AppKit

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> [CGFloat]? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let values = args[i + 1].split(separator: ",").compactMap { Double($0) }.map { CGFloat($0) }
    args.removeSubrange(i...(i + 1))
    return values
}
let box = option("--box"), lineY = option("--line")?.first
guard args.count == 7, let left = NSImage(contentsOfFile: args[1]), let right = NSImage(contentsOfFile: args[4]) else {
    FileHandle.standardError.write("usage: compare OUT LEFT TITLE NOTE RIGHT TITLE NOTE [--box x,y,w,h] [--line y]\n".data(using: .utf8)!)
    exit(2)
}
func pixelSize(_ image: NSImage) -> NSSize {
    let rep = image.representations.first
    return NSSize(width: rep?.pixelsWide ?? Int(image.size.width), height: rep?.pixelsHigh ?? Int(image.size.height))
}
let ls = pixelSize(left), rs = pixelSize(right)
let pad: CGFloat = 20, gap: CGFloat = 28, head: CGFloat = 74, foot: CGFloat = 20
let width = pad * 2 + ls.width + gap + rs.width, height = head + max(ls.height, rs.height) + foot
let red = NSColor(calibratedRed: 1, green: 0.36, blue: 0.36, alpha: 1)
let green = NSColor(calibratedRed: 0.35, green: 0.85, blue: 0.45, alpha: 1)
let canvas = NSImage(size: NSSize(width: width, height: height))
canvas.lockFocusFlipped(true)
NSColor(calibratedWhite: 0.09, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
func text(_ s: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, _ color: NSColor, bold: Bool) {
    let font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
    (s as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: font, .foregroundColor: color])
}
let lx = pad, rx = pad + ls.width + gap
text(args[2], lx, 18, 19, .white, bold: true)
text(args[3], lx, 46, 13, red, bold: false)
text(args[5], rx, 18, 19, .white, bold: true)
text(args[6], rx, 46, 13, green, bold: false)
left.draw(in: NSRect(x: lx, y: head, width: ls.width, height: ls.height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
right.draw(in: NSRect(x: rx, y: head, width: rs.width, height: rs.height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
if let b = box, b.count == 4 {
    let path = NSBezierPath(roundedRect: NSRect(x: lx + b[0], y: head + b[1], width: b[2], height: b[3]), xRadius: 8, yRadius: 8)
    path.lineWidth = 2.5
    red.setStroke()
    path.stroke()
}
if let y = lineY {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: rx + 4, y: head + y))
    path.line(to: NSPoint(x: rx + rs.width - 4, y: head + y))
    path.lineWidth = 2.5
    path.setLineDash([7, 5], count: 2, phase: 0)
    green.setStroke()
    path.stroke()
}
canvas.unlockFocus()
let rep = NSBitmapImageRep(data: canvas.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[0]))
