import type { CustomerReceipt } from "@floor/domain";

function wrap(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = words[0] ?? "";
  for (const word of words.slice(1)) {
    const next = `${current} ${word}`;
    if (font.widthOfTextAtSize(next, size) <= max) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

export async function renderReceiptPdf(doc: CustomerReceipt): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const pageSize: [number, number] = [612, 792];
  let page = pdf.addPage(pageSize);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const black = rgb(0, 0, 0);
  const left = 54;
  const right = 558;
  const width = right - left;
  let y = 738;
  const bottom = 54;

  function ensure(space: number) {
    if (y - space >= bottom) return;
    page = pdf.addPage(pageSize);
    y = 738;
  }

  function write(text: string, size: number, f = font, x = left) {
    ensure(size + 4);
    page.drawText(text, { x, y, size, font: f, color: black });
    y -= size + 4;
  }

  function writeRight(text: string, size: number, f = font) {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: right - w, y, size, font: f, color: black });
  }

  function para(text: string, size: number, f = font) {
    for (const line of wrap(text, f, size, width)) {
      write(line, size, f);
    }
  }

  write(doc.storeName, 18, bold);
  para(doc.storeAddress, 11);
  if (doc.storeEmail) write(doc.storeEmail, 11);
  y -= 10;
  page.drawLine({ start: { x: left, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.75, color: black });
  y -= 6;

  write("Receipt", 10, font);
  y += 2;
  write(doc.reference, 14, bold);
  if (doc.soldOnLabel) {
    write("Date", 10);
    y += 2;
    write(doc.soldOnLabel, 12, bold);
  }

  if (doc.customer) {
    y -= 6;
    write("Sold to", 10);
    if (doc.customer.name) write(doc.customer.name, 12, bold);
    if (doc.customer.email) write(doc.customer.email, 11);
  }

  y -= 8;
  page.drawLine({ start: { x: left, y: y + 10 }, end: { x: right, y: y + 10 }, thickness: 0.5, color: black });
  y -= 4;

  for (const line of doc.lines) {
    ensure(72);
    const top = y;
    write(`SKU ${line.sku}`, 11, bold);
    const identity = [line.brand, line.model].filter(Boolean).join(" ");
    if (identity) para(identity, 11, bold);
    if (line.description) para(line.description, 11);
    para(`Condition: ${line.condition}`, 11);
    const after = y;
    y = top;
    writeRight(line.priceLabel, 12, bold);
    y = Math.min(after, y - 16);
    y -= 6;
  }

  page.drawLine({ start: { x: left, y: y + 10 }, end: { x: right, y: y + 10 }, thickness: 0.5, color: black });
  y -= 4;

  function totalRow(label: string, amount: string, strong = false) {
    ensure(20);
    const size = strong ? 13 : 11;
    const f = strong ? bold : font;
    page.drawText(label, { x: left, y, size, font: f, color: black });
    writeRight(amount, size, f);
    y -= size + 8;
  }

  totalRow("Subtotal", doc.subtotalLabel);
  if (doc.saleDiscountCents) totalRow("Discount", doc.saleDiscountLabel);
  totalRow(doc.taxLineLabel, doc.taxAmountLabel);
  totalRow("Total", doc.totalLabel, true);

  y -= 6;
  if (doc.paymentMethod) write(`Payment: ${doc.paymentMethod}`, 11);
  if (doc.channel) write(`Channel: ${doc.channel}`, 11);

  y -= 12;
  page.drawLine({ start: { x: left, y: y + 10 }, end: { x: right, y: y + 10 }, thickness: 0.5, color: black });
  y -= 4;
  para(doc.returnPolicy, 9);

  return pdf.save();
}
