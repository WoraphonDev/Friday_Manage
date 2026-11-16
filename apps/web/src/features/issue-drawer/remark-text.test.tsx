import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { addTrackerIds, insertLink, isWebUrl, parseIds, RemarkText, type IssueTracker } from './remark-text';

const REDMINE: IssueTracker = { name: 'Redmine', urlTemplate: 'http://redmine.example.com/redmine/issues/{id}' };
const JIRA: IssueTracker = { name: 'Jira', urlTemplate: 'https://acme.example.com/browse/{id}' };
const links = () => screen.queryAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

describe('หมายเหตุ: แสดงลิงก์', () => {
  it('เลขงานของระบบที่ตั้งไว้ · คงข้อความตามที่พิมพ์ · เปิดแท็บใหม่', () => {
    const { container } = render(<RemarkText trackers={[REDMINE]} text={'รอทดสอบ\nRedmine # : 111004 , 111005 แก้แล้ว\nบรรทัดท้าย 2025'} />);
    expect(links()).toEqual([['111004', 'http://redmine.example.com/redmine/issues/111004'], ['111005', 'http://redmine.example.com/redmine/issues/111005']]);
    expect(container.textContent).toBe('รอทดสอบ\nRedmine # : 111004 , 111005 แก้แล้ว\nบรรทัดท้าย 2025');
    expect(screen.getByRole('link', { name: '111004' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: '111004' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('หลายระบบ · ไม่สนตัวพิมพ์ · Jira ABC-123 · ระบบที่ไม่ได้ตั้งเป็นข้อความธรรมดา', () => {
    render(<RemarkText trackers={[REDMINE, JIRA]} text={'redmine#:110997 · JIRA # : DE-12, DE-13 · Trello # : 55'} />);
    expect(links()).toEqual([
      ['110997', 'http://redmine.example.com/redmine/issues/110997'],
      ['DE-12', 'https://acme.example.com/browse/DE-12'],
      ['DE-13', 'https://acme.example.com/browse/DE-13'],
    ]);
  });

  it('ลิงก์ภายนอก: [ชื่อ](URL) และ URL เปล่า · ไม่รับ javascript: · จุดท้ายประโยคไม่ติดลิงก์', () => {
    const { container } = render(<RemarkText trackers={[]} text={'ดู [สเปก](https://docs.example.com/spec-v2) และ https://example.com/a?b=1. [x](javascript:alert(1))'} />);
    expect(links()).toEqual([['สเปก', 'https://docs.example.com/spec-v2'], ['https://example.com/a?b=1', 'https://example.com/a?b=1']]);
    expect(container.textContent).toBe('ดู สเปก และ https://example.com/a?b=1. [x](javascript:alert(1))');
  });

  it('ไม่ตั้งระบบไว้ = เลขงานเป็นข้อความธรรมดา', () => {
    render(<RemarkText trackers={[]} text="Redmine # : 110997" />);
    expect(links()).toEqual([]);
  });
});

describe('หมายเหตุ: แทรกเลขงาน / ลิงก์', () => {
  it('parseIds: คั่นด้วยจุลภาค / ช่องว่าง · ตัดซ้ำ · แยกตัวที่ไม่ใช่เลขงาน', () => {
    expect(parseIds(' 111006, 111007 111006 ')).toEqual({ ids: ['111006', '111007'], invalid: [] });
    expect(parseIds('ABC-12, abc')).toEqual({ ids: ['ABC-12'], invalid: ['abc'] });
  });

  it('addTrackerIds: ต่อท้ายบรรทัดเดิม · ไม่ซ้ำ · ยังไม่มีบรรทัด = ขึ้นบรรทัดใหม่', () => {
    expect(addTrackerIds('รอทดสอบ\nRedmine # : 111000 , 111004', 'Redmine', ['111004', '111006'])).toBe('รอทดสอบ\nRedmine # : 111000 , 111004 , 111006');
    expect(addTrackerIds('รอทดสอบ', 'Redmine', ['1', '2'])).toBe('รอทดสอบ\nRedmine # : 1 , 2');
    expect(addTrackerIds('', 'Jira', ['DE-1'])).toBe('Jira # : DE-1');
    expect(addTrackerIds('redmine #:', 'Redmine', ['5'])).toBe('redmine #: 5');
  });

  it('insertLink: แทรกตรงเคอร์เซอร์ · เว้นวรรคเมื่อติดตัวอักษร · ไม่มีชื่อ = URL เปล่า', () => {
    expect(insertLink('ดูสเปกนี้', 3, 3, 'https://x.example.com', 'สเปก')).toEqual({ text: 'ดูส [สเปก](https://x.example.com) เปกนี้', cursor: 33 });
    expect(insertLink('ดู ', 3, 3, 'https://x.example.com', ' ')).toEqual({ text: 'ดู https://x.example.com', cursor: 24 });
    expect(isWebUrl('https://x.example.com/a')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('x.example.com')).toBe(false);
  });
});
