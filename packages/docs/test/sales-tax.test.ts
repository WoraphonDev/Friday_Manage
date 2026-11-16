// สรุปภาษีขาย (สูตรเดียวของการ์ด E1 · รายงาน PDF / Excel · หน้ารายงานรายได้) · ตรวจเลขขาดแยกตามชุดเลข · ZIP · ข้อมูลสมมติ
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { numberSeries, salesTaxChecks, salesTaxSummary, type SalesRow, zip } from '../src/index.ts';

const row = (r: Partial<SalesRow> & Pick<SalesRow, 'number' | 'kind' | 'value' | 'vat'>, detail: Partial<SalesRow['detail']> = {}): SalesRow => ({
  date: '2026-11-03', buyerName: 'บริษัท ตัวอย่าง จำกัด', buyerTaxId: '0105560000001', branch: 'สำนักงานใหญ่',
  detail: { ref: 'FRI-2611-0001', plan: 'Team S · รายเดือน', whtAmount: 0, received: 0, receivedOn: null, channel: 'โอน', etax: 'ส่งแล้ว', etaxState: 'done', flags: [], ...detail },
  ...r,
});

describe('ตรวจเลขขาดแยกตามชุดเลข', () => {
  it('ฉบับที่ออกแทนได้เลขของเดือนที่ออกจริง ไม่ทำให้เดือนเดิมหรือเดือนใหม่เตือนผิด · เลขขาดจริงยังเจอ', () => {
    // พ.ย. มี TX-2611-0001..0003 · ฉบับแทนของ พ.ย. ออกเดือน ธ.ค. ได้ TX-2612-0002 (ลงวันที่ พ.ย.) · ธ.ค. มี 0001, 0003 ของตัวเอง
    expect(numberSeries(['TX-2611-0001', 'TX-2611-0002', 'TX-2611-0003', 'TX-2612-0002', 'TX-2612-0001', 'TX-2612-0003', 'CN-2611-0001'])).toEqual([
      { series: 'CN-2611', prefix: 'CN', first: 1, last: 1, missing: [] },
      { series: 'TX-2611', prefix: 'TX', first: 1, last: 3, missing: [] },
      { series: 'TX-2612', prefix: 'TX', first: 1, last: 3, missing: [] },
    ]);
    expect(numberSeries(['TX-2611-0001', 'TX-2611-0004', 'FRI-OLD', 'DN-2611-0002', 'DN-2611-0003'])).toEqual([
      { series: 'DN-2611', prefix: 'DN', first: 2, last: 3, missing: [] },
      { series: 'TX-2611', prefix: 'TX', first: 1, last: 4, missing: [2, 3] },
    ]);
  });
});

describe('สรุปภาษีขาย', () => {
  const rows: SalesRow[] = [
    row({ number: 'TX-2611-0001', kind: 'tax_invoice', value: 150_000, vat: 10_500 }, { whtAmount: 4_500, flags: ['wht'] }),
    row({ number: 'TX-2611-0002', kind: 'tax_invoice', value: 0, vat: 0, cancelled: true, note: 'ยกเลิก · ออกใหม่เป็น TX-2612-0001' }, { etaxState: 'cancel_pending' }),
    row({ number: 'TX-2612-0001', kind: 'tax_invoice', value: 300_000, vat: 21_000, note: 'ออกแทน TX-2611-0002' }, { etaxState: 'failed' }),
    row({ number: 'DN-2611-0001', kind: 'debit_note', value: 50_000, vat: 3_500 }, { etaxState: 'waiting', flags: ['outstanding'] }),
    row({ number: 'CN-2611-0001', kind: 'credit_note', value: -100_000, vat: -7_000 }, { etaxState: 'done' }),
  ];

  it('ใบลดหนี้ลบ ใบเพิ่มหนี้บวก ใบยกเลิกเป็น 0 และนับคู่ยกเลิก / ออกแทนครั้งเดียว · สถานะ e-Tax รวมการแจ้งยกเลิก', () => {
    const s = salesTaxSummary(rows);
    expect(s.net).toEqual({ value: 400_000, vat: 28_000, total: 428_000 });
    expect(s.lines.map((l) => [l.kind, l.count, l.cancelled, l.replaced, l.first, l.last])).toEqual([
      ['tax_invoice', 2, 1, 1, 'TX-2611-0001', 'TX-2612-0001'],
      ['debit_note', 1, 0, 0, 'DN-2611-0001', 'DN-2611-0001'],
      ['credit_note', 1, 0, 0, 'CN-2611-0001', 'CN-2611-0001'],
    ]);
    expect(s.etax).toEqual({ total: 5, done: 2, failed: 1, waiting: 1, pending: 0, cancelPending: 1, numbers: ['TX-2611-0002', 'TX-2612-0001', 'DN-2611-0001'] });
    expect(s.wht).toEqual({ count: 1, amount: 4_500 });
    // ใบเสร็จตอนยังไม่จด VAT ไม่ต้องส่ง e-Tax
    expect(salesTaxSummary([row({ number: 'RC-2611-0001', kind: 'receipt', value: 100, vat: 0 }, { etaxState: 'not_required' })]).etax.total).toBe(0);
  });

  it('รายการตรวจก่อนปิดงวด: เลขขาด / e-Tax ไม่ครบ = ต้องดู · 50 ทวิ ใบ ฿0 ค้างรับ = เตือน', () => {
    const checks = salesTaxChecks(rows, { series: numberSeries(['TX-2611-0001', 'TX-2611-0002', 'TX-2612-0001', 'DN-2611-0001', 'CN-2611-0001']), zeroInvoices: 2 });
    expect(checks.map((c) => [c.code, c.level])).toEqual([
      ['numbers', 'ok'],
      ['etax', 'bad'],
      ['replacements', 'ok'],
      ['wht', 'warn'],
      ['outstanding', 'warn'],
      ['zero_invoices', 'warn'],
    ]);
    expect(checks[0].text).toBe('เลขเอกสารต่อเนื่อง · TX-2611 0001–0002 · TX-2612 0001 · CN 0001 · DN 0001');
    expect(checks[1]).toMatchObject({ ok: false, params: { n: 3 }, text: 'e-Tax ยังไม่ครบ 3 ฉบับ (TX-2611-0002, TX-2612-0001, DN-2611-0001)' });
    expect(checks[3].text).toBe('50 ทวิ ยังไม่ได้รับ 1 ใบ ฿45 (ไม่บล็อกการปิดงวด)');
    const gap = salesTaxChecks([row({ number: 'TX-2611-0003', kind: 'tax_invoice', value: 1, vat: 0 })], { series: numberSeries(['TX-2611-0001', 'TX-2611-0003']) });
    expect(gap[0]).toMatchObject({ ok: false, level: 'bad', text: 'เลขเอกสารขาด TX-2611-0002' });
  });
});

describe('ZIP', () => {
  it('ชื่อไฟล์ภาษาไทยและโฟลเดอร์ · อ่านกลับได้', () => {
    const files = [{ name: 'TX/TX-2611-0001.pdf', data: Buffer.from('%PDF-1.4 ตัวอย่าง') }, { name: 'รายงาน.csv', data: Buffer.from('a,b\n1,2\n'.repeat(50)) }];
    const z = zip(files);
    expect(z.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const end = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(z.readUInt16LE(end + 10)).toBe(2);
    let p = 0;
    for (const f of files) {
      const nameLen = z.readUInt16LE(p + 26);
      expect(z.subarray(p + 30, p + 30 + nameLen).toString('utf8')).toBe(f.name);
      const size = z.readUInt32LE(p + 18);
      expect(inflateRawSync(z.subarray(p + 30 + nameLen, p + 30 + nameLen + size))).toEqual(f.data);
      p += 30 + nameLen + size;
    }
  });
});
