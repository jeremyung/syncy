// Draws Syncy's app icon and writes an `.iconset` ready for `iconutil`.
//
// The icon is the panel's own vocabulary at Dock scale: warm paper, a serif
// wordmark letter in ink, and beneath it the proportion rule — the four ledger
// states in the order the app always reads them, weakest first. Nothing here is
// a badge or a glyph invented for the icon; it is the same paper, the same
// serif and the same four colours the ledger uses, which is what makes the tile
// recognisable as this app rather than as a category of app.
//
// Two thick elements only. A stack of thin ledger rules is prettier at 512 and
// unreadable at 32, and 32 is where an icon actually earns its keep.
//
// Run: swift scripts/make-app-icon.swift <output.iconset>

import AppKit
import Foundation

let outputPath = CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : "build/Syncy.iconset"

// MARK: - Palette, taken from the app's light theme

let paperTop = NSColor(srgbRed: 0.992, green: 0.980, blue: 0.961, alpha: 1)
let paperBottom = NSColor(srgbRed: 0.937, green: 0.914, blue: 0.867, alpha: 1)
let ink = NSColor(srgbRed: 0.145, green: 0.137, blue: 0.122, alpha: 1)
let hairline = NSColor(srgbRed: 0.847, green: 0.831, blue: 0.796, alpha: 1)

let verified = NSColor(srgbRed: 0.23, green: 0.47, blue: 0.32, alpha: 1)
let caution = NSColor(srgbRed: 0.68, green: 0.43, blue: 0.12, alpha: 1)
let unchecked = NSColor(srgbRed: 0.58, green: 0.56, blue: 0.53, alpha: 1)
let fault = NSColor(srgbRed: 0.64, green: 0.24, blue: 0.20, alpha: 1)

/// Weakest first, and weighted the way a real archive is: mostly settled, with
/// the states that need reading occupying the width they actually earn.
let ruleSegments: [(color: NSColor, weight: CGFloat)] = [
  (fault, 0.10),
  (caution, 0.16),
  (unchecked, 0.24),
  (verified, 0.50),
]

// MARK: - Drawing

func drawIcon(size: CGFloat) -> NSBitmapImageRep {
  let pixels = Int(size)
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)
  else { fatalError("could not allocate a \(pixels)pt bitmap") }

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let context = NSGraphicsContext.current!.cgContext
  context.setShouldAntialias(true)

  // macOS leaves the tile inset from its slot; 0.09 on each side is the
  // proportion the system icons keep.
  let inset = size * 0.09
  let body = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  let radius = body.width * 0.2237
  let squircle = NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius)

  context.saveGState()
  squircle.addClip()
  let gradient = NSGradient(starting: paperTop, ending: paperBottom)!
  gradient.draw(in: body, angle: -90)
  context.restoreGState()

  // A hairline keeps the paper from dissolving into a light desktop.
  hairline.setStroke()
  squircle.lineWidth = max(1, size * 0.004)
  squircle.stroke()

  // The wordmark letter, optically centred in the space above the rule rather
  // than in the tile — a cap sits high in its own line box and centring by the
  // box leaves it looking dropped.
  let fontSize = body.height * 0.60
  let descriptor = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
    .fontDescriptor.withDesign(.serif) ?? NSFont.systemFont(ofSize: fontSize).fontDescriptor
  let font = NSFont(descriptor: descriptor, size: fontSize) ?? NSFont.systemFont(ofSize: fontSize)
  let letter = NSAttributedString(
    string: "S", attributes: [.font: font, .foregroundColor: ink])
  let letterSize = letter.size()
  let letterOrigin = CGPoint(
    x: body.midX - letterSize.width / 2,
    y: body.minY + body.height * 0.315)
  letter.draw(at: letterOrigin)

  // The proportion rule, in the app's own geometry: square ends, hairline gaps,
  // and a floor so the smallest state survives the smallest tile.
  let ruleWidth = body.width * 0.58
  let ruleHeight = max(2, body.height * 0.082)
  let ruleY = body.minY + body.height * 0.155
  let gap = max(0.5, body.width * 0.011)
  let totalGaps = gap * CGFloat(ruleSegments.count - 1)
  let floor = max(1, body.width * 0.02)
  let free = max(0, ruleWidth - totalGaps - floor * CGFloat(ruleSegments.count))

  var x = body.midX - ruleWidth / 2
  for segment in ruleSegments {
    let width = floor + free * segment.weight
    segment.color.setFill()
    CGRect(x: x, y: ruleY, width: width, height: ruleHeight).fill()
    x += width + gap
  }

  NSGraphicsContext.restoreGraphicsState()
  return rep
}

// MARK: - Write the iconset

let sizes: [(name: String, pixels: CGFloat)] = [
  ("icon_16x16", 16), ("icon_16x16@2x", 32),
  ("icon_32x32", 32), ("icon_32x32@2x", 64),
  ("icon_128x128", 128), ("icon_128x128@2x", 256),
  ("icon_256x256", 256), ("icon_256x256@2x", 512),
  ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

let directory = URL(fileURLWithPath: outputPath)
try? FileManager.default.removeItem(at: directory)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

for entry in sizes {
  let rep = drawIcon(size: entry.pixels)
  guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("could not encode \(entry.name)")
  }
  try data.write(to: directory.appendingPathComponent("\(entry.name).png"))
}

print(directory.path)
