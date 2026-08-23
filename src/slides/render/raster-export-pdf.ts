import { PDFDocument } from "pdf-lib";

const FIXED_DATE = new Date("2000-01-01T00:00:00.000Z");

export async function assembleRasterPdf(pngBytes: readonly Uint8Array[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Deterministic raster deck");
  pdf.setAuthor("meeting-slides");
  pdf.setSubject("Product-owned raster export");
  pdf.setKeywords(["meeting-slides", "raster"]);
  pdf.setProducer("meeting-slides raster-export");
  pdf.setCreator("meeting-slides raster-export");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  for (const bytes of pngBytes) {
    const image = await pdf.embedPng(bytes);
    const page = pdf.addPage([960, 540]);
    page.drawImage(image, { x: 0, y: 0, width: 960, height: 540 });
  }

  return pdf.save({ addDefaultPage: false, useObjectStreams: false, updateFieldAppearances: false });
}
