import { describe, expect, it } from 'vitest';
import { bahtText, renderBill, thaiDate } from '../src/payments/pdf.js';

describe('เอกสารการเงิน PDF', () => {
  it('อ่านจำนวนเงินเป็นตัวอักษรตามธรรมเนียมไทย', () => {
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
  });
  it('วันที่แบบไทย พ.ศ.', () => {
    expect(thaiDate('2026-11-12')).toBe('12 พฤศจิกายน 2569');
    expect(thaiDate('2027-01-05', true)).toBe('5 ม.ค. 2570');
  });
  it('สร้าง PDF หน้าเดียวได้แม้ข้อความยาว', async () => {
    const pdf = await renderBill({
      title: 'ใบแจ้งหนี้', subtitle: 'Invoice', number: 'FRI-2611-0001', date: '2026-11-12', dueDate: '2026-11-19', status: 'รอชำระเงิน / Unpaid',
      seller: { name: 'บริษัท ตัวอย่าง จำกัด', taxId: '0105500000000', branch: 'สำนักงานใหญ่', address: '1 ถนนตัวอย่าง' },
      buyer: { companyName: 'ลูกค้าตัวอย่าง', taxId: '0000000000000', branch: 'สาขาที่ 00001', address: 'ที่อยู่ตัวอย่าง '.repeat(12), email: 'billing@example.com' },
      lines: [{ description: 'รายการตัวอย่างที่ยาวมาก '.repeat(8), amount: 100000 }],
      subtotal: 100000, vat: 7000, total: 107000, whtAmount: 3000, amountDue: 104000, notes: ['หมายเหตุตัวอย่าง'], footer: ['ท้ายเอกสารตัวอย่าง'],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
  });
});
