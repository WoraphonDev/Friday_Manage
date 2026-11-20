// ย้ายงานข้ามโปรเจกต์ (storyboard 2026-11-20) · ข้อมูลสมมติเท่านั้น
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@/test/render';
import { server } from '@/test/server';
import { navigation, router } from '@/test/router';
import { IssueDrawerHost } from '@/features/issue-drawer/IssueDrawer';
import { failure, fixture, me } from '@/features/issue-drawer/fixtures.test-support';
import { MoveIssuesDialog, type MovePreview } from './move-dialog';

const base = '*/api/v1/w/sample';
const preview: MovePreview = {
  source: { key: 'DE', name: 'ร้านกาแฟออนไลน์' },
  target: { key: 'WEB', name: 'เว็บไซต์บริษัท', visibility: 'private' },
  issues: [
    { key: 'DE-12', newKey: 'WEB-46', title: 'หน้าชำระเงินผ่าน QR', subtask: false },
    { key: 'DE-13', newKey: 'WEB-47', title: 'สร้าง QR', subtask: true },
  ],
  count: 2, subtasks: 1, pulled: ['DE-13'],
  types: [{ from: { id: 't-task', name: 'Task' }, to: { id: 'w-task', name: 'Task' }, byName: true, count: 2 }],
  typeOptions: [{ id: 'w-task', name: 'Task' }, { id: 'w-story', name: 'Story' }],
  statuses: [
    { key: 't-task:s-prog', typeName: 'Task', from: { id: 's-prog', name: 'In progress', category: 'in_progress' }, to: null, byName: false, suggested: { id: 'w-doing', name: 'กำลังทำ' }, options: [{ id: 'w-todo', name: 'To do', category: 'todo' }, { id: 'w-doing', name: 'กำลังทำ', category: 'in_progress' }], count: 1 },
    { key: 't-task:s-todo', typeName: 'Task', from: { id: 's-todo', name: 'To do', category: 'todo' }, to: { id: 'w-todo', name: 'To do' }, byName: true, suggested: { id: 'w-todo', name: 'To do' }, options: [{ id: 'w-todo', name: 'To do', category: 'todo' }, { id: 'w-doing', name: 'กำลังทำ', category: 'in_progress' }], count: 1 },
  ],
  modules: [{ id: 'm-web', name: 'หน้าเว็บ' }],
  labels: { create: ['urgent'] },
  dropped: { requirements: ['FR-01.2'], screens: [], milestones: [], customFields: ['ลูกค้า'], dependencies: [{ issue: 'DE-12', other: 'DE-9' }], dueRequests: 0 },
  people: { outside: [{ id: 'u2', name: 'ผู้พัฒนาสอง' }], canInvite: true },
  files: { move: 2, keep: 1, folder: 'ย้ายมาจาก DE' },
};

describe('หน้าต่างย้ายงาน', () => {
  it('เลือกปลายทาง → เห็นเลขใหม่ การจับคู่ และสิ่งที่ตามไปไม่ได้ · สถานะที่ไม่ตรงชื่อใช้ค่าแนะนำ · ส่งการจับคู่ไปตอนย้าย', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    server.use(
      http.get(`${base}/projects`, () => HttpResponse.json({ items: [{ key: 'DE', name: 'ร้านกาแฟออนไลน์', joined: true }, { key: 'WEB', name: 'เว็บไซต์บริษัท', joined: true }, { key: 'OLD', name: 'เก็บถาวร', joined: true, archivedAt: '2026-10-01T00:00:00Z' }] })),
      http.post(`${base}/issues/move/preview`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json(preview))),
      http.post(`${base}/issues/move`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ key: 'WEB-46', moved: [{ from: 'DE-12', to: 'WEB-46' }, { from: 'DE-13', to: 'WEB-47' }], target: { key: 'WEB', name: 'เว็บไซต์บริษัท' } }))),
    );
    const onMoved = vi.fn();
    renderWithProviders(<MoveIssuesDialog ws="sample" sourceKey="DE" keys={['DE-12']} open onOpenChange={() => {}} onMoved={onMoved} />);
    const dialog = await screen.findByRole('dialog', { name: 'ย้าย DE-12 ไปโปรเจกต์อื่น' });
    const target = within(dialog).getByLabelText('โปรเจกต์ปลายทาง');
    await waitFor(() => expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual(['เลือกโปรเจกต์', 'WEB · เว็บไซต์บริษัท']));
    expect(within(dialog).getByRole('button', { name: 'ย้ายงาน 1 งาน' })).toBeDisabled();
    await user.selectOptions(target, 'WEB');
    expect(await within(dialog).findByText('DE-12 จะเป็น WEB-46')).toBeInTheDocument();
    expect(within(dialog).getByText('ย้ายไปด้วย 2 งาน: DE-12 → WEB-46 · DE-13 → WEB-47')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('สถานะ Task In progress')).toHaveValue('w-doing');
    expect(within(dialog).getByText('เลือกเอง')).toBeInTheDocument();
    expect(within(dialog).getByText('ตามไปไม่ได้ 3 อย่าง · บันทึกไว้ในประวัติของงาน')).toBeInTheDocument();
    expect(within(dialog).getByText('ลิงก์ Requirement FR-01.2')).toBeInTheDocument();
    expect(within(dialog).getByText('งานที่ต้องเสร็จก่อน / หลัง: DE-9 (ยังอยู่โปรเจกต์เดิม)')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'เพิ่มเป็นสมาชิก WEB' })).toBeChecked();
    expect(within(dialog).getByText(/ไฟล์แนบ 2 ไฟล์ย้ายไปโฟลเดอร์ "ย้ายมาจาก DE"/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Module'), 'm-web');
    await user.click(within(dialog).getByRole('button', { name: 'ย้ายงาน 2 งาน' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ key: 'WEB-46' })));
    expect(sent[0]).toEqual({ keys: ['DE-12'], targetProjectKey: 'WEB', typeMap: {} });
    expect(sent.at(-1)).toEqual({ keys: ['DE-12'], targetProjectKey: 'WEB', typeMap: { 't-task': 'w-task' }, statusMap: { 't-task:s-prog': 'w-doing', 't-task:s-todo': 'w-todo' }, moduleId: 'm-web', addMembers: true });
  });

  it('ไม่มีสิทธิ์ในปลายทาง: แสดงข้อความจาก API และย้ายไม่ได้', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${base}/projects`, () => HttpResponse.json({ items: [{ key: 'WEB', name: 'เว็บไซต์บริษัท', joined: true }] })),
      http.post(`${base}/issues/move/preview`, () => HttpResponse.json({ error: { code: 'forbidden', message: 'ไม่มีสิทธิ์สร้างงานในโปรเจกต์นี้', details: {} } }, { status: 403 })),
    );
    renderWithProviders(<MoveIssuesDialog ws="sample" sourceKey="DE" keys={['DE-12', 'DE-20']} open onOpenChange={() => {}} onMoved={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'ย้าย 2 งานไปโปรเจกต์อื่น' });
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(within(dialog).getByLabelText('โปรเจกต์ปลายทาง'), 'WEB');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ไม่มีสิทธิ์สร้างงานในโปรเจกต์นี้');
    expect(within(dialog).getByRole('button', { name: 'ย้ายงาน 2 งาน' })).toBeDisabled();
  });
});

describe('Key เดิมของงานที่ย้ายแล้ว', () => {
  it('เปิด ?issue=DE-9 ที่ย้ายไป WEB-3 แล้ว → พาไปแท็บเดียวกันของโปรเจกต์ WEB โดยคงตัวกรองเดิม', async () => {
    const f = fixture();
    // handler ที่ส่งก่อนชนะ: Key เดิมตอบ 301 ก่อน handler กลางของ fixture
    server.use(http.get(`${base}/issues/DE-9`, () => failure(404, 'issue_moved', { key: 'WEB-3', oldKey: 'DE-9' })), ...f.handlers);
    navigation.pathname = '/work/sample/p/DE/board';
    navigation.search = 'issue=DE-9&filter=open';
    router.replace.mockClear();
    renderWithProviders(<IssueDrawerHost ws="sample" projectKey="DE" meId={me.id} issueKey="DE-9" onClose={() => {}} />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/work/sample/p/WEB/board?filter=open&issue=WEB-3', { scroll: false }));
  });
});
