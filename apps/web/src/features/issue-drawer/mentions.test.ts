import { describe, expect, it } from 'vitest';
import { forDisplay, toDisplay, toStored } from './mentions';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';

describe('mention ในคอมเมนต์', () => {
  it('แปลงไปกลับระหว่างช่องพิมพ์กับรูปแบบที่ API เก็บ', () => {
    const stored = `รอ @[ผู้ทดสอบ](${a}) กับ @[ผู้ทดสอบ สอง](${b}) ตรวจ`;
    const shown = toDisplay(stored);
    expect(shown.text).toBe('รอ @ผู้ทดสอบ กับ @ผู้ทดสอบ สอง ตรวจ');
    expect(toStored(shown.text, shown.picks)).toBe(stored);
  });
  it('ไม่แปลงอีเมลหรือชื่อที่ยาวกว่า และไม่แปลงซ้ำ', () => {
    const picks = new Map([['ZO', a]]);
    expect(toStored('ส่ง a@ZO.com ถึง @ZOE และ @ZO', picks)).toBe(`ส่ง a@ZO.com ถึง @ZOE และ @[ZO](${a})`);
    expect(toStored(`@[ZO](${a})`, picks)).toBe(`@[ZO](${a})`);
  });
  it('แสดงผลให้ @ อยู่ในป้ายชื่อเดียวกัน', () => {
    expect(forDisplay(`รอ @[ZO](${a})`)).toBe(`รอ [@ZO](${a})`);
  });
});
