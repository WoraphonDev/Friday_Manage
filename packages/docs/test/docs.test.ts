// เอกสารการเงิน · ข้อมูลสมมติทั้งหมด (ไม่มีเลขผู้เสียภาษี / บัญชีจริง)
// ตั้ง DOCS_PREVIEW_DIR เพื่อเก็บ PDF ไว้เปิดดูเทียบกับ design/proposals/billing/03-billing-documents.html
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { adjustmentDoc, bahtText, branchLabel, chargeLines, invoiceDoc, quotationDoc, receiptDoc, renderDoc, renderSalesReport, salesReportXlsx, summarize, thaiDate, thaiNumericDate, type SalesRow, type Seller } from '../src/index.ts';

const seller: Seller = { name: 'บริษัท ฟรายเดย์ จำกัด', taxId: '0105500000000', address: '99 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10000', branch: 'สำนักงานใหญ่', phone: '02-000-0000', email: 'billing@example.com', sample: true };
const buyer = { companyName: 'บริษัท ทดสอบเอกสาร จำกัด', taxId: '1234567890123', branchType: 'branch', branchNo: '2', address: '1 ถนนทดสอบ แขวงทดสอบ เขตทดสอบ กรุงเทพมหานคร 10110', email: 'billing@example.com' };
const charge = { planName: 'Team M', cycle: 'monthly' as const, periodStart: '2026-11-16', periodEnd: '2026-12-15', seatLimit: 25, seatsUsed: 12, subtotal: 270_000, discount: 30_000, discountLabel: 'โค้ด WELCOME10 (10%)' };
const bank = { bank: 'ธนาคารตัวอย่าง', accountName: 'บริษัท ฟรายเดย์ จำกัด', accountNo: '000-0-00000-0' };
const preview = process.env.DOCS_PREVIEW_DIR;
const save = (name: string, buf: Buffer) => {
  if (!preview) return;
  mkdirSync(preview, { recursive: true });
  writeFileSync(join(preview, name), buf);
};
const isPdf = (b: Buffer) => b.subarray(0, 4).toString('latin1') === '%PDF';

describe('รูปแบบ', () => {
  it('จำนวนเงินตัวอักษรตามธรรมเนียมไทย (ย้ายมาจาก apps/api › bill-pdf.test)', () => {
    expect(bahtText(321000)).toBe('สามพันสองร้อยสิบบาทถ้วน');
    expect(bahtText(2100)).toBe('ยี่สิบเอ็ดบาทถ้วน');
    expect(bahtText(1100)).toBe('สิบเอ็ดบาทถ้วน');
    expect(bahtText(10100)).toBe('หนึ่งร้อยเอ็ดบาทถ้วน');
    expect(bahtText(100)).toBe('หนึ่งบาทถ้วน');
    expect(bahtText(100000100)).toBe('หนึ่งล้านเอ็ดบาทถ้วน');
    expect(bahtText(2500000000)).toBe('ยี่สิบห้าล้านบาทถ้วน');
    expect(bahtText(150050)).toBe('หนึ่งพันห้าร้อยบาทห้าสิบสตางค์');
    expect(bahtText(25)).toBe('ยี่สิบห้าสตางค์');
    expect(bahtText(0)).toBe('ศูนย์บาทถ้วน');
    expect(thaiDate('2026-11-12', false)).toBe('12 พฤศจิกายน 2569');
    expect(thaiDate('2027-01-05')).toBe('5 ม.ค. 2570');
  });

  it('จำนวนเงินตัวอักษร · วันที่ พ.ศ. · สาขา 5 หลัก', () => {
    expect(bahtText(288_900)).toBe('สองพันแปดร้อยแปดสิบเก้าบาทถ้วน');
    expect(bahtText(192_600)).toBe('หนึ่งพันเก้าร้อยยี่สิบหกบาทถ้วน');
    expect(bahtText(100_150)).toBe('หนึ่งพันเอ็ดบาทห้าสิบสตางค์');
    expect(thaiDate('2026-11-17')).toBe('17 พ.ย. 2569');
    expect(thaiNumericDate('2026-12-05')).toBe('05/12/69');
    expect(branchLabel('branch', '2')).toBe('สาขาที่ 00002');
    expect(branchLabel('head', null)).toBe('สำนักงานใหญ่');
  });

  it('รายการขาย: แพ็กเกจ + ส่วนลดแยกบรรทัด · ใบที่ทีมออกเองใช้รายการที่กรอก', () => {
    expect(chargeLines(charge)).toEqual([
      expect.objectContaining({ qty: 1, unit: 'เดือน', unitPrice: 300_000, amount: 300_000, sub: 'รอบบริการ 16 พ.ย. 2569 – 15 ธ.ค. 2569 · สมาชิกสูงสุด 25 คน' }),
      expect.objectContaining({ description: 'ส่วนลด โค้ด WELCOME10 (10%)', amount: -30_000 }),
    ]);
    expect(chargeLines({ ...charge, subtotal: 100_000, items: [{ description: 'ค่าตั้งค่าระบบ', qty: 2, unitSatang: 50_000 }] })).toEqual([{ description: 'ค่าตั้งค่าระบบ', qty: 2, unit: 'รายการ', unitPrice: 50_000, amount: 100_000 }]);
    // ส่วนลดเป็นเปอร์เซ็นต์ของใบที่ทีมออกเอง: แสดงผลต่างเป็นบรรทัดส่วนลด
    expect(chargeLines({ ...charge, subtotal: 90_000, discountLabel: '10%', items: [{ description: 'ค่าตั้งค่าระบบ', qty: 2, unitSatang: 50_000 }] }).at(-1)).toEqual({ description: 'ส่วนลด 10%', qty: 1, unit: 'รายการ', unitPrice: -10_000, amount: -10_000 });
  });
});

describe('PDF ตามแม่แบบเดียว', () => {
  it('ใบเสนอราคา · ใบแจ้งหนี้ · ใบเสร็จ/ใบกำกับภาษี · ฉบับแทน · ใบลดหนี้ · ใบเพิ่มหนี้', async () => {
    const docs = {
      quotation: quotationDoc({ seller, buyer, number: 'QT-2611-0012', date: '2026-11-15', validUntil: '2026-12-15', planName: 'Team M', cycle: 'monthly', seatLimit: 25, storageGbPerMember: 10, yearlyPrice: 3_000_000, yearlyMonths: 10, subtotal: 270_000, discount: 30_000, discountLabel: 'โค้ด WELCOME10 (10%)', vat: 18_900, total: 288_900, whtAmount: 8_100, amountDue: 280_800, vatRegistered: true }),
      invoice: invoiceDoc({ seller, buyer, edition: 'original', number: 'FRI-2611-0007', date: '2026-11-16', dueDate: '2026-11-23', status: 'open', poNumber: 'PO-2026-0118', workspaceName: 'ทดสอบเอกสาร', charge, vat: 18_900, total: 288_900, whtAmount: 8_100, amountDue: 280_800, vatRegistered: true, method: 'transfer', bank }),
      receipt: receiptDoc({ seller, buyer, edition: 'original', vatRegistered: true, number: 'TX-2611-0003', date: '2026-11-17', invoiceNumber: 'FRI-2611-0007', poNumber: 'PO-2026-0118', charge, vat: 18_900, total: 288_900, whtAmount: 8_100, payment: { paidAt: new Date('2026-11-17T03:42:00Z'), method: 'transfer', reference: 'FRI-2611-0007', received: 280_800 }, nextBillingDate: '2026-12-16' }),
      replacement: receiptDoc({ seller, buyer: { ...buyer, companyName: 'บริษัท ตัวอย่างสอง จำกัด', taxId: '0105560000002', branchType: 'head' }, edition: 'original', vatRegistered: true, number: 'TX-2612-0003', date: '2026-12-05', invoiceNumber: 'FRI-2612-0004', charge: { ...charge, subtotal: 300_000, discount: 0 }, vat: 21_000, total: 321_000, whtAmount: 0, payment: { paidAt: new Date('2026-12-05T02:15:00Z'), method: 'card', reference: 'pi_sample_0001', received: 321_000, cardLast4: '4242' }, replaces: { number: 'TX-2612-0002', date: '2026-12-05', reason: 'เลขประจำตัวผู้เสียภาษีของผู้ซื้อในฉบับเดิมไม่ถูกต้อง', issuedOn: '2026-12-08' } }),
      credit: adjustmentDoc({ kind: 'credit', seller, buyer, edition: 'original', vatRegistered: true, number: 'CN-2612-0001', date: '2026-12-02', reason: 'ยกเลิกแพ็กเกจ Team M วันที่ 26 พ.ย. 2569 · ทีมงานอนุมัติคืนส่วนที่ยังไม่ได้ใช้ 20 จาก 30 วัน', ref: { number: 'TX-2611-0003', date: '2026-11-17' }, line: { description: 'ค่าบริการ Friday Work Management แพ็กเกจ Team M (รายเดือน)', sub: 'รอบบริการ 16 พ.ย. 2569 – 15 ธ.ค. 2569', original: 270_000 }, difference: 180_000, vat: 12_600, band: { title: 'การคืนเงิน / Settlement', cells: [['วิธี', 'โอนคืนเข้าบัญชีลูกค้า'], ['วันที่คืน', '3 ธ.ค. 2569'], ['อ้างอิง', 'CN-2612-0001'], ['จำนวน', '฿1,926.00']] } }),
      debit: adjustmentDoc({ kind: 'debit', seller, buyer, edition: 'original', vatRegistered: true, number: 'DN-2612-0001', date: '2026-12-04', reason: 'ส่วนลดโค้ด PARTNER20 ถูกใช้หลังโค้ดหมดอายุ · เรียกเก็บส่วนลดที่ให้เกินสิทธิ์', ref: { number: 'TX-2610-0009', date: '2026-10-16' }, line: { description: 'ค่าบริการ Friday Work Management แพ็กเกจ Team M (รายเดือน)', original: 240_000 }, difference: 60_000, vat: 4_200, band: { title: 'การชำระ / Payment', cells: [['ครบกำหนด', '11 ธ.ค. 2569'], ['ใบแจ้งหนี้', 'FRI-2612-0006'], ['ชำระที่', 'แพ็กเกจ & Billing › ชำระ'], ['ยอด', '฿642.00']] } }),
    };
    expect(docs.credit.totals.at(-1)).toMatchObject({ label: 'รวมลดหนี้ / Total credit', value: 192_600 });
    expect(docs.credit.table).toMatchObject({ kind: 'adjust', lines: [{ original: 270_000, correct: 90_000, difference: 180_000 }] });
    expect(docs.debit.table).toMatchObject({ lines: [{ original: 240_000, correct: 300_000, difference: 60_000 }] });
    expect(docs.replacement.remark?.text).toContain('TX-2612-0002');
    expect(docs.receipt.band?.cells[0][0]).toBe('วันที่ได้รับเงิน (ตามสลิป)');
    for (const [name, d] of Object.entries(docs)) {
      const buf = await renderDoc(d);
      expect(isPdf(buf), name).toBe(true);
      save(`${name}.pdf`, buf);
    }
  });

  it('ข้อความยาวยังได้หน้าเดียว · รายการมากขึ้นหน้าใหม่พร้อมเลขหน้า', async () => {
    const base = invoiceDoc({ seller, buyer: { ...buyer, address: 'ที่อยู่ตัวอย่าง '.repeat(12) }, edition: 'original', number: 'FRI-2611-0001', date: '2026-11-12', dueDate: '2026-11-19', status: 'open', charge: { ...charge, planName: 'รายการตัวอย่างที่ยาวมาก '.repeat(6) }, vat: 18_900, total: 288_900, whtAmount: 0, amountDue: 288_900, vatRegistered: true, bank });
    const pages = (b: Buffer) => b.toString('latin1').match(/\/Type \/Page\b/g)?.length;
    expect(pages(await renderDoc(base))).toBe(1);
    const many = { ...base, table: { kind: 'sale' as const, lines: Array.from({ length: 40 }, (_, i) => ({ description: `รายการที่ ${i + 1}`, qty: 1, unit: 'รายการ', unitPrice: 1000, amount: 1000 })) } };
    const buf = await renderDoc(many);
    save('invoice-many.pdf', buf);
    expect(pages(buf)).toBeGreaterThan(1);
  });

  it('ยังไม่จด VAT: ใบเสร็จรับเงิน ไม่มีคำว่าใบกำกับภาษีและไม่มีบรรทัด VAT', () => {
    const d = receiptDoc({ seller, buyer, edition: 'copy', vatRegistered: false, number: 'RC-2611-0001', date: '2026-11-17', invoiceNumber: 'FRI-2611-0007', charge: { ...charge, discount: 0, subtotal: 300_000 }, vat: 0, total: 300_000, whtAmount: 0, payment: { paidAt: new Date(), method: 'promptpay', received: 300_000 } });
    expect(d.title).toBe('ใบเสร็จรับเงิน');
    expect(d.badge).toBe('สำเนา / COPY');
    expect(d.totals.map((t) => t.label)).toEqual(['รวมทั้งสิ้น / Total']);
    expect(d.notes.join(' ')).not.toContain('e-Tax');
  });
});

describe('รายงานภาษีขาย', () => {
  const row = (r: Partial<SalesRow> & Pick<SalesRow, 'number' | 'kind' | 'value' | 'vat'>): SalesRow => ({ date: '2026-12-01', buyerName: 'บริษัท ตัวอย่างหนึ่ง จำกัด', buyerTaxId: '0105560000001', branch: 'สำนักงานใหญ่', detail: { ref: 'FRI-2612-0001', plan: 'Team S · รายเดือน', whtAmount: 0, received: r.value + r.vat, receivedOn: '2026-12-01', channel: 'PromptPay', etax: 'ส่งแล้ว', flags: [] }, ...r });
  const rows: SalesRow[] = [
    row({ number: 'TX-2612-0001', kind: 'tax_invoice', value: 150_000, vat: 10_500 }),
    row({ date: '2026-12-02', number: 'CN-2612-0001', kind: 'credit_note', value: -180_000, vat: -12_600, note: 'ใบลดหนี้ อ้างถึง TX-2611-0003' }),
    row({ date: '2026-12-04', number: 'DN-2612-0001', kind: 'debit_note', value: 60_000, vat: 4_200, detail: { ref: 'TX-2610-0009', plan: 'Team M · รายเดือน', whtAmount: 0, received: 0, receivedOn: null, channel: 'รอชำระ', etax: 'ส่งแล้ว', flags: ['outstanding'] } }),
    row({ date: '2026-12-05', number: 'TX-2612-0002', kind: 'tax_invoice', value: 0, vat: 0, cancelled: true, note: 'ยกเลิก · ออกใหม่เป็น TX-2612-0003' }),
    row({ date: '2026-12-05', number: 'TX-2612-0003', kind: 'tax_invoice', value: 300_000, vat: 21_000, note: 'ออกแทน TX-2612-0002' }),
    row({ date: '2026-12-16', number: 'TX-2612-0004', kind: 'tax_invoice', value: 270_000, vat: 18_900, detail: { ref: 'FRI-2612-0009', plan: 'Team M · รายเดือน', whtAmount: 8_100, received: 280_800, receivedOn: '2026-12-16', channel: 'โอน (สลิป)', etax: 'ส่งแล้ว', flags: ['wht'] } }),
  ];
  const input = { seller, year: 2026, month: 12, rows, closed: false, generatedAt: new Date('2027-01-01T02:00:00Z'), checks: [{ ok: true, text: 'เลขใบกำกับภาษีต่อเนื่อง ไม่มีเลขขาด' }, { ok: false, text: 'รอ 50 ทวิ 1 ใบ' }] };

  it('สรุป: ใบลดหนี้ลบ ใบเพิ่มหนี้บวก ใบยกเลิกเป็น 0 · ยอดสุทธิใช้กรอก ภ.พ.30', () => {
    const s = summarize(rows);
    expect(s.value).toBe(600_000);
    expect(s.vat).toBe(42_000);
    expect(s.byKind.find((k) => k.kind === 'tax_invoice')).toMatchObject({ count: 4, cancelled: 1, value: 720_000, vat: 50_400 });
  });

  it('PDF 2 หน้า + Excel 2 แท็บ', async () => {
    const buf = await renderSalesReport(input);
    expect(isPdf(buf)).toBe(true);
    save('sales-report.pdf', buf);
    const xlsx = await salesReportXlsx(input);
    save('sales-report.xlsx', xlsx);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['รายงานภาษีขาย', 'รายละเอียด']);
    const sheet = wb.getWorksheet('รายงานภาษีขาย')!;
    const total = sheet.getRow(sheet.rowCount);
    expect([total.getCell(6).value, total.getCell(7).value, total.getCell(8).value]).toEqual(['รวม', 6000, 420]);
  });
});
