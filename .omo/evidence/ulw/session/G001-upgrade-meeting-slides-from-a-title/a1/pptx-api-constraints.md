# Editable PPTX API constraints

Installed runtime: `pptxgenjs@3.12.0`

Official references:

- https://gitbrent.github.io/PptxGenJS/
- https://gitbrent.github.io/PptxGenJS/docs/speaker-notes.html
- https://gitbrent.github.io/PptxGenJS/docs/api-shapes.html
- https://gitbrent.github.io/PptxGenJS/docs/api-images.html
- https://github.com/gitbrent/PptxGenJS/blob/master/types/index.d.ts

## Confirmed portable surface

- `LAYOUT_WIDE` is 13.333 x 7.5 inches and matches the 16:9 deck canvas.
- `slide.addText` emits editable DrawingML text boxes.
- `slide.addShape` emits native editable PowerPoint shapes.
- `slide.addImage` accepts local/data image sources and explicit crop/contain placement.
- `slide.addNotes` writes speaker notes.
- Shape options expose an optional `shapeName`, suitable for stable Selection Pane identity.
- Presentation-level theme fonts and metadata are supported.
- `writeFile` is the supported filesystem output boundary.

## Version-specific constraints

- Implementation must target the installed 3.12.0 declarations, not assume newer v4-only
  object identity or accessibility properties.
- Geometry already owns final line breaks and font sizes. The PPTX renderer must not use
  unqualified `fit: "shrink"`, `autoFit`, DOM conversion, or screenshot text.
- Meaningful text remains editable text. Simple diagrams remain native shapes. Raster images
  are permitted only for image assets, never for slide text.
- Asset paths are verified local content-addressed files. No remote URL is passed to PptxGenJS.
- Speaker notes carry slide evidence and diagnostic metadata.
- Stable shape names are used where the 3.12.0 type/runtime supports them. Unsupported
  accessibility metadata is preserved in the publication manifest and notes rather than
  patched blindly into OOXML.
- Any direct OOXML patch requires a reproduced PptxGenJS gap, a version allowlist, package
  parsing before/after, and an explicit regression fixture. No generic OOXML mutation helper.

## Required acceptance gates

1. ZIP signature, CRC, XML parse, content types, and relationship graph.
2. Wide layout and expected slide count/order.
3. Planned text appears as editable `<a:t>` objects, not pictures.
4. Stable text/shape/image counts and names.
5. Notes match slide IDs and evidence references.
6. No dangling or external relationships.
7. Font substitutions and unsupported features are reported.
8. LibreOffice isolated-profile open/save/reopen when available.
9. Native PowerPoint repair-free open/save/reopen before production-ready status.
10. Text, shape, and image mutation probes survive reopen.
