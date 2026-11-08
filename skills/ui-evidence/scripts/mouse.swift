// Usage: mouse click X Y | mouse move X Y | mouse scroll X Y DY
// Posts real HID events; Electron apps ignore System Events "click at".
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    FileHandle.standardError.write("usage: mouse click|move X Y | mouse scroll X Y DY\n".data(using: .utf8)!)
    exit(2)
}
let point = CGPoint(x: x, y: y)
func post(_ type: CGEventType) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved)
usleep(120_000)
switch args[1] {
case "click":
    post(.leftMouseDown)
    usleep(80_000)
    post(.leftMouseUp)
case "scroll":
    let dy = Int32(args.count > 4 ? args[4] : "-400") ?? -400
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
case "move":
    break
default:
    exit(2)
}
