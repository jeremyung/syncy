// Draws Syncy's app icon and writes an `.iconset` ready for `iconutil`.
//
// The mark is the wordmark's first letter and a colon: `S:`, a serif cap in ink
// on warm paper. The colon is the part that means something — it is the
// punctuation of a statement about to be made, which is the whole job of this
// app: it tells you where your files stand. Nothing here is a badge or a glyph
// invented for the icon; the paper and the ink are the app's own light theme.
//
// Flat, not layered: one paper fill, one ink mark, no gradient and no bevel.
// A gradient tile reads as depth at 512 and as a smudge at 32, and 32 is where
// an icon actually earns its keep. Two elements only, both of them solid.
//
// Run: swift scripts/make-app-icon.swift <output.iconset>

import AppKit
import CoreText
import Foundation

let outputPath = CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : "build/Syncy.iconset"

// MARK: - Palette, taken from the app's light theme

// Warmer than the panel's own paper on purpose. The flat tile has no gradient
// to separate it from what is behind it, and a near-white square vanishes into
// a Finder list, which is white.
let paper = NSColor(srgbRed: 0.961, green: 0.945, blue: 0.918, alpha: 1)
let ink = NSColor(srgbRed: 0.145, green: 0.137, blue: 0.122, alpha: 1)
let hairline = NSColor(srgbRed: 0.847, green: 0.831, blue: 0.796, alpha: 1)

// MARK: - Proportions

/// The tile's own metrics, in fractions of the icon's edge, and the mark's, in
/// fractions of the tile. Small tiles get a thinner margin and a larger cap:
/// at 16pt the system's 9% inset spends a fifth of the icon on nothing, and the
/// letter left inside it is four pixels of stem.
struct Metrics {
  let inset: CGFloat
  let capHeight: CGFloat
  let weight: NSFont.Weight

  static func forSize(_ size: CGFloat) -> Metrics {
    // Heavier than the tiles above it, which is not an inconsistency: at a cap
    // of eight pixels a bold serif is mostly hairline, and the 16pt letter came
    // out a grey smear beside two solid dots. Heavy holds its stems and still
    // keeps the counters of the S open; black closes them.
    if size <= 16 {
      return Metrics(inset: 0.055, capHeight: 0.58, weight: .heavy)
    }
    if size <= 32 {
      return Metrics(inset: 0.06, capHeight: 0.62, weight: .bold)
    }
    if size <= 64 {
      return Metrics(inset: 0.075, capHeight: 0.60, weight: .semibold)
    }
    return Metrics(inset: 0.09, capHeight: 0.56, weight: .semibold)
  }
}

/// The dot's diameter and the colon's spacing, both in fractions of the cap.
/// Measured off the mark rather than off the font's own colon: a text colon is
/// sized to sit beside lowercase in running text, and beside a cap at icon
/// scale its dots are specks that the first downscale erases.
let dotDiameter: CGFloat = 0.30
let dotTop: CGFloat = 0.86
let colonGap: CGFloat = 0.13

// MARK: - Drawing

/// The letter's true ink box — what is painted, not the line box it is painted
/// in. A cap sits high in its line box with room below for descenders, so
/// centring by the box leaves the mark looking dropped, and there is no way to
/// align the colon to a cap you have not measured.
func inkBounds(of text: String, font: NSFont) -> CGRect {
  let attributed = NSAttributedString(string: text, attributes: [.font: font])
  let line = CTLineCreateWithAttributedString(attributed)
  return CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
}

func serifFont(ofSize size: CGFloat, weight: NSFont.Weight) -> NSFont {
  let base = NSFont.systemFont(ofSize: size, weight: weight)
  guard let descriptor = base.fontDescriptor.withDesign(.serif) else { return base }
  return NSFont(descriptor: descriptor, size: size) ?? base
}

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

  let metrics = Metrics.forSize(size)
  let inset = (size * metrics.inset).rounded()
  let body = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  let radius = body.width * 0.2237

  paper.setFill()
  NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius).fill()

  // A hairline keeps the paper from dissolving into a light desktop. Drawn
  // inside the edge: a stroke centred on the path spills half its width into
  // the transparent margin, which at 16pt is the whole margin.
  let lineWidth = max(1, (size * 0.004).rounded())
  let edge = body.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
  let edgeRadius = max(0, radius - lineWidth / 2)
  let border = NSBezierPath(roundedRect: edge, xRadius: edgeRadius, yRadius: edgeRadius)
  hairline.setStroke()
  border.lineWidth = lineWidth
  border.stroke()

  // Size the letter by what it paints, and measure again after each guess.
  // One scaling pass is not enough: the system serif carries optical sizes, so
  // a cap measured on a 12pt trial is a different shape from the cap that comes
  // back at 9pt, and scaling once from the trial overshot the 16pt tile far
  // enough that the letter drew over its own border.
  let targetCap = body.height * metrics.capHeight
  var font = serifFont(ofSize: targetCap * 1.4, weight: metrics.weight)
  var letterInk = inkBounds(of: "S", font: font)
  for _ in 0..<4 {
    guard letterInk.height > 0.001 else { break }
    let corrected = font.pointSize * (targetCap / letterInk.height)
    guard abs(corrected - font.pointSize) > 0.01 else { break }
    font = serifFont(ofSize: corrected, weight: metrics.weight)
    letterInk = inkBounds(of: "S", font: font)
  }

  // Everything below is proportioned off the cap that was actually fitted, not
  // off the cap that was asked for, so the colon cannot drift away from a
  // letter that landed a fraction short of its target.
  let cap = letterInk.height

  // Both dots are floored at a whole pixel and their diameter rounded, because
  // a 1.4pt circle antialiases into a grey nothing. Rounding the diameter also
  // keeps the pair identical: two dots a fraction of a pixel apart in size are
  // visibly unequal at 16pt, which reads as a defect rather than as a colon.
  let dot = max(2, (cap * dotDiameter).rounded())
  let gap = max(1, (cap * colonGap).rounded())

  let markWidth = letterInk.width + gap + dot
  let markLeft = (body.midX - markWidth / 2).rounded()
  // The ink box is centred in the tile, so the letter and the colon sit on the
  // same optical centre line rather than on the font's baseline.
  let markBottom = (body.midY - cap / 2).rounded()

  // Drawn through Core Text at an explicit baseline. `NSAttributedString.draw`
  // places the *line box*, which carries the descent of a letter that has none:
  // asking it to put the ink at the centre line put the cap a full descender
  // above it, and the colon — laid out from the same measurement — hung off the
  // letter's bottom left instead of beside it.
  let letter = NSAttributedString(
    string: "S", attributes: [.font: font, .foregroundColor: ink])
  context.textPosition = CGPoint(x: markLeft - letterInk.minX, y: markBottom - letterInk.minY)
  CTLineDraw(CTLineCreateWithAttributedString(letter), context)

  // The colon hangs off the cap: bottom dot on the letter's own baseline, top
  // dot below its apex. Aligned to the cap band, not to the tile, the pair
  // stays put at every size in the set.
  let dotX = markLeft + letterInk.width + gap
  let dotBottoms = [markBottom, markBottom + max(dot + 1, (cap * dotTop - dot).rounded())]
  ink.setFill()
  for bottom in dotBottoms {
    let box = CGRect(x: dotX, y: bottom, width: dot, height: dot)
    // Below about four pixels a circle is no longer a circle, it is a square
    // with its corners rubbed off: the 16pt dots came out two-thirds grey and
    // read as smudges. At that size the square is the honest dot.
    if dot <= 4 {
      box.fill()
    } else {
      NSBezierPath(ovalIn: box).fill()
    }
  }

  NSGraphicsContext.restoreGraphicsState()
  return rep
}

// MARK: - Write the iconset

// The full set macOS asks for. Every slot is drawn at its own pixel size rather
// than downscaled from 1024: the Finder list and the menu's 16pt tiles are the
// ones a resample ruins, and they are also the ones seen most often.
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
