import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@/test/render';
import { server } from '@/test/server';
import { navigation, router } from '@/test/router';
import { IssueDrawerHost } from './IssueDrawer';
import { failure, fixture, formOptions, makeIssue, me, dev, statuses, uid } from './fixtures.test-support';
import type { Issue, Feed } from './types';

let f: ReturnType<typeof fixture>;
const close = vi.fn();
const issueEndpoint = '*/api/v1/w/:ws/issues/:key';
const projectEndpoint = '*/api/v1/w/:ws/projects/:project';
function mount(issueKey: string | undefined = 'DE-1', props: Partial<Parameters<typeof IssueDrawerHost>[0]> = {}) {
  return renderWithProviders(<IssueDrawerHost ws="sample" projectKey="DE" meId={me.id} issueKey={issueKey} onClose={close} {...props} />);
}
const loaded = () => screen.findByRole('button', { name: 'งานตัวอย่าง DE-1' });
const mutations = (suffix: string) => f.state.mutations.filter((row) => row.path.endsWith(suffix));
beforeEach(() => { f = fixture(); server.use(...f.handlers); close.mockClear(); localStorage.clear(); navigation.pathname='/w/sample/p/DE/board'; navigation.search='issue=DE-1&filter=open'; });

describe('Issue drawer details', () => {
  it('loads issue properties, subtasks and safe Markdown; unavailable tabs stay hidden', async () => {
    f.state.issues.get('DE-1')!.description='**รายละเอียดสำคัญ**\n\n<script>alert(1)</script>\n\n[ลิงก์อันตราย](javascript:alert(1))';
    const view=mount();
    expect(screen.getAllByLabelText('กำลังโหลด…').length).toBeGreaterThan(0);
    await loaded();
    expect(screen.getByText('รายละเอียดสำคัญ')).toBeInTheDocument();
    expect(view.baseElement.querySelector('script')).toBeNull();
    expect(view.baseElement.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByRole('button',{name:/DE-2.*งานย่อยหนึ่ง/})).toBeInTheDocument();
    expect(screen.getByLabelText('สถานะ')).toHaveValue(statuses[1].id);
    expect(screen.queryByRole('tab',{name:'ไฟล์'})).not.toBeInTheDocument();
    expect(screen.queryByRole('tab',{name:'Git'})).not.toBeInTheDocument();
  });

  it('saves individual fields with current If-Match on successive edits', async () => {
    const user=userEvent.setup();mount();await user.click(await loaded());
    const title=screen.getByRole('textbox',{name:'ชื่อเรื่อง'});await user.clear(title);await user.type(title,'ชื่อใหม่');
    await user.click(screen.getByRole('button',{name:'บันทึก'}));
    await screen.findByRole('button',{name:'ชื่อใหม่'});
    expect(mutations('/issues/DE-1')[0]).toMatchObject({body:{title:'ชื่อใหม่'},etag:'"3"'});
    await user.selectOptions(screen.getByLabelText('Priority'),'high');
    await waitFor(()=>expect(mutations('/issues/DE-1')).toHaveLength(2));
    expect(mutations('/issues/DE-1')[1]).toMatchObject({body:{priority:'high'},etag:'"4"'});
  });

  it('keeps the draft and blocks further changes after409 until loading latest', async () => {
    const user=userEvent.setup();
    server.use(http.patch(issueEndpoint,async({request})=>{const body=await request.json() as Record<string,unknown>;f.state.issues.get('DE-1')!.title='ชื่อจากผู้อื่น';f.state.issues.get('DE-1')!.version=9;return failure(409,'conflict',{latest:f.state.issues.get('DE-1')});}));
    mount();await user.click(await loaded());await user.clear(screen.getByLabelText('ชื่อเรื่อง'));await user.type(screen.getByLabelText('ชื่อเรื่อง'),'แบบที่กำลังแก้');await user.click(screen.getByRole('button',{name:'บันทึก'}));
    await screen.findByText('มีการแก้ไขงานระหว่างที่คุณกำลังแก้');
    expect(screen.getByLabelText('ชื่อเรื่อง')).toHaveValue('แบบที่กำลังแก้');
    expect(screen.getByLabelText('Priority')).toBeDisabled();
    expect(screen.getByText(/req_drawer_test/)).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'โหลดค่าล่าสุด'}));
    await waitFor(()=>expect(screen.getByLabelText('Priority')).toBeEnabled());
    expect(screen.getByLabelText('ชื่อเรื่อง')).toHaveValue('แบบที่กำลังแก้');
  });

  it('PUT assignees sends If-Match and member ids from the real member contract', async () => {
    const user=userEvent.setup();mount();await loaded();
    await user.click(screen.getByRole('button',{name:'ผู้รับผิดชอบ'}));
    await user.click(within(screen.getByRole('listbox')).getByRole('option',{name:new RegExp(dev.displayName)}));
    await waitFor(()=>expect(mutations('/assignees')).toHaveLength(1));
    expect(mutations('/assignees')[0]).toMatchObject({method:'PUT',body:{assigneeIds:[me.id,dev.id]},etag:'"3"'});
  });

  it('shows Requirement / Screen / Labels and replaces each set with PATCH', async () => {
    Object.assign(f.state.issues.get('DE-1')!,{requirements:['FR-06.2','NFR-01'],screens:['SCR-107'],labels:[formOptions.labels[0]]});
    const user=userEvent.setup();mount();await loaded();
    const props=screen.getByRole('complementary',{name:/คุณสมบัติ|Properties/});
    expect(within(props).getByText('FR-06.2')).toBeInTheDocument();expect(within(props).getByText('SCR-107')).toBeInTheDocument();expect(within(props).getByText('backend')).toBeInTheDocument();
    await user.click(within(props).getByRole('button',{name:'ลบ NFR-01'}));
    await waitFor(()=>expect(mutations('/issues/DE-1')[0]).toMatchObject({body:{requirements:['FR-06.2']},etag:'"3"'}));
    await user.click(await within(props).findByRole('button',{name:'+ Label'}));await user.selectOptions(within(props).getByLabelText('เลือก Label'),uid(81));
    await waitFor(()=>expect(mutations('/issues/DE-1')[1]).toMatchObject({body:{labelIds:[uid(80),uid(81)]},etag:'"4"'}));
    expect(await within(props).findByText('ตรวจซ้ำ')).toBeInTheDocument();
  });

  it('requires confirmation before moving Done with incomplete subtasks', async () => {
    const user=userEvent.setup();const calls:Record<string,unknown>[]=[];
    server.use(http.post(`${issueEndpoint}/move`,async({request})=>{const body=await request.json() as Record<string,unknown>;calls.push(body);expect(request.headers.get('if-match')).toBe('"3"');if(!body.confirm)return failure(422,'subtasks_incomplete',{open:2,confirmable:true});const issue=f.state.issues.get('DE-1')!;issue.status=statuses[3];issue.version++;return HttpResponse.json({...issue,warnings:[]});}));
    mount();await loaded();await user.selectOptions(screen.getByLabelText('สถานะ'),statuses[3].id);
    await screen.findByRole('dialog',{name:'Sub-task ยังไม่เสร็จ'});
    expect(calls).toHaveLength(1);await user.click(screen.getByRole('button',{name:'ยืนยันย้าย'}));
    await waitFor(()=>expect(calls.at(-1)).toMatchObject({statusId:statuses[3].id,confirm:true}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Sub-task ยังไม่เสร็จ'})).not.toBeInTheDocument());
  });

  it('asks for a Baseline reason and resubmits the same edit', async () => {
    const user=userEvent.setup();const calls:Record<string,unknown>[]=[];
    server.use(http.patch(issueEndpoint,async({request})=>{const body=await request.json() as Record<string,unknown>;calls.push(body);if(!body.planChangeReason)return failure(400,'plan_change_reason_required');const issue=f.state.issues.get('DE-1')!;issue.estimateMd=Number(body.estimateMd);issue.version++;return HttpResponse.json(issue);}));
    mount();await loaded();const field=screen.getByText('Man-Day').parentElement!;await user.click(within(field).getByRole('button'));
    await user.clear(screen.getByLabelText('Man-Day'));await user.type(screen.getByLabelText('Man-Day'),'6');await user.click(screen.getByRole('button',{name:'บันทึก'}));
    await screen.findByRole('dialog',{name:'เหตุผลที่แก้แผน'});await user.type(screen.getByLabelText('เหตุผลการเปลี่ยนแผน'),'ปรับขอบเขตงาน');await user.click(within(screen.getByRole('dialog',{name:'เหตุผลที่แก้แผน'})).getByRole('button',{name:'บันทึก'}));
    await waitFor(()=>expect(calls.at(-1)).toEqual({estimateMd:6,planChangeReason:'ปรับขอบเขตงาน'}));
  });

  it('opens subtask at depth2, navigates siblings and preserves other URL filters', async () => {
    const user=userEvent.setup();mount();await loaded();await user.click(screen.getByRole('button',{name:/DE-2.*งานย่อยหนึ่ง/}));
    const child=await screen.findByRole('dialog',{name:'รายละเอียดงาน DE-2'});
    await waitFor(()=>expect(screen.getByRole('dialog',{name:'รายละเอียดงาน DE-2'})).toHaveClass('drawer-nested'));
    const childPanel=screen.getByRole('dialog',{name:'รายละเอียดงาน DE-2'});
    expect(router.replace).toHaveBeenLastCalledWith('/w/sample/p/DE/board?filter=open&issue=DE-2',{scroll:false});
    await user.click(within(childPanel).getByRole('button',{name:'Sub-task ถัดไป'}));
    await screen.findByRole('dialog',{name:'รายละเอียดงาน DE-3'});
    fireEvent.keyDown(document.body,{key:'ArrowLeft'});
    await screen.findByRole('dialog',{name:'รายละเอียดงาน DE-2'});
    await user.click(within(screen.getByRole('dialog',{name:'รายละเอียดงาน DE-2'})).getByRole('button',{name:/DE-1 · งานตัวอย่าง DE-1/}));
    await screen.findByRole('dialog',{name:'รายละเอียดงาน DE-1'});
    expect(screen.queryByRole('dialog',{name:'รายละเอียดงาน DE-2'})).not.toBeInTheDocument();
  });

  it('reopens Bug to its initial workflow status', async () => {
    const user=userEvent.setup();mount('DE-4');await screen.findByRole('button',{name:'Bug ตัวอย่าง'});await user.click(screen.getByRole('button',{name:'เปิด Bug อีกครั้ง'}));
    await user.click(within(screen.getByRole('dialog',{name:'เปิด Bug อีกครั้ง'})).getByRole('button',{name:'เปิด Bug อีกครั้ง'}));
    await waitFor(()=>expect(mutations('/reopen')).toHaveLength(1));
    await screen.findByText('เปิดใหม่ 1 ครั้ง');
  });
});

describe('Due request',()=>{
  beforeEach(()=>{f.state.access.permissions=f.state.access.permissions.filter((permission)=>permission!=='issue.change_due_directly');});
  async function chooseDue(user:ReturnType<typeof userEvent.setup>,date:string){await user.click(screen.getByRole('button',{name:/วันครบกำหนด/}));await user.clear(screen.getByLabelText('วันครบกำหนด',{selector:'input'}));await user.type(screen.getByLabelText('วันครบกำหนด',{selector:'input'}),date);}
  it('previews impact, submits and cancels an own pending request',async()=>{
    const user=userEvent.setup();mount();await loaded();await user.click(screen.getByRole('button',{name:'ขอเลื่อน Due'}));
    await user.type(screen.getByLabelText('Due ใหม่'),'2026-11-13');
    await screen.findByText('เพิ่ม 4 วันทำการ');expect(screen.getByText(/งานอื่น 8 MD/)).toBeInTheDocument();expect(screen.getByText(/เลยกำหนด ส่งมอบตัวอย่าง/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('เหตุผล'),'waiting_input');await user.type(screen.getByLabelText('รายละเอียดเหตุผล'),'รอข้อมูลตัวอย่าง');await user.click(screen.getByRole('button',{name:'ส่งคำขอ'}));
    await screen.findByText(/ขอเลื่อนเป็น/);
    expect(mutations('/due-requests')[0].body).toEqual({requestedDue:'2026-11-13',reasonCode:'waiting_input',detail:'รอข้อมูลตัวอย่าง'});
    expect(mutations('/issues/DE-1')).toHaveLength(0);
    await user.click(screen.getByRole('button',{name:'ยกเลิกคำขอ'}));await user.click(within(screen.getByRole('dialog',{name:'ยกเลิกคำขอ'})).getByRole('button',{name:'ยกเลิกคำขอ'}));
    await waitFor(()=>expect(mutations(`/due-requests/${uid(80)}/cancel`)).toHaveLength(1));
  });
  it('handles computed postponement403 from an estimate edit',async()=>{
    const user=userEvent.setup();server.use(http.patch(issueEndpoint,()=>failure(403,'due_change_requires_approval',{canRequest:true,requestedDue:'2026-11-13'})));
    mount();await loaded();await user.click(within(screen.getByText('Man-Day').parentElement!).getByRole('button'));await user.clear(screen.getByLabelText('Man-Day'));await user.type(screen.getByLabelText('Man-Day'),'8');await user.click(screen.getByRole('button',{name:'บันทึก'}));
    await screen.findByRole('dialog',{name:'ขอเลื่อนวันครบกำหนด'});expect(screen.getByLabelText('Due ใหม่')).toHaveValue('2026-11-13');
  });
  it('blocks submission when preview fails and displays requestId',async()=>{
    const user=userEvent.setup();server.use(http.get(`${issueEndpoint}/due-requests/preview`,()=>failure(500,'failed')));mount();await loaded();await user.click(screen.getByRole('button',{name:'ขอเลื่อน Due'}));await user.type(screen.getByLabelText('Due ใหม่'),'2026-11-13');await screen.findByText(/req_drawer_test/);expect(screen.getByRole('button',{name:'ส่งคำขอ'})).toBeDisabled();expect(mutations('/due-requests')).toHaveLength(0);
  });
});

describe('Issue parts and comments',()=>{
  it('creates and toggles acceptance items, reorders and deletes checklist entries',async()=>{
    const user=userEvent.setup();mount();await loaded();await screen.findByLabelText('ตรวจสอบข้อมูล');
    await user.click(screen.getByLabelText('ตรวจสอบข้อมูล'));await waitFor(()=>expect(f.state.checklist[0].done).toBe(true));
    await user.click(screen.getByRole('button',{name:'เลื่อน ยืนยันผลลัพธ์ ขึ้น'}));await waitFor(()=>expect(f.state.checklist[0].text).toBe('ยืนยันผลลัพธ์'));
    const acceptance=screen.getByRole('region',{name:'Acceptance criteria'});await user.type(within(acceptance).getByLabelText('เพิ่ม Acceptance criteria'),'ตรวจรับงานใหม่');await user.click(within(acceptance).getByRole('button',{name:'เพิ่ม'}));await screen.findByLabelText('ตรวจรับงานใหม่');
    expect(mutations('/checklist').at(-1)?.body).toEqual({text:'ตรวจรับงานใหม่',kind:'acceptance'});
    await user.click(screen.getByRole('button',{name:'ลบ Checklist ตรวจรับงานใหม่'}));await waitFor(()=>expect(screen.queryByLabelText('ตรวจรับงานใหม่')).not.toBeInTheDocument());
  });
  it('adds typed dependency with lag, displays cycle failure and removes an edge',async()=>{
    const user=userEvent.setup();mount();await loaded();await screen.findByRole('button',{name:/DE-9.*งานที่ต้องรอ/});
    await user.click(screen.getByRole('button',{name:'เพิ่ม Dependency'}));await user.click(screen.getByRole('button',{name:'รหัสงานที่เชื่อม'}));await user.type(screen.getByLabelText('ค้นหารหัสหรือชื่องาน เช่น DEMO-7'),'DE-4');await user.click(await screen.findByRole('option',{name:/DE-4/}));await user.selectOptions(screen.getByLabelText('ชนิด Dependency'),'SS');await user.clear(screen.getByLabelText('ระยะห่างวันทำการ'));await user.type(screen.getByLabelText('ระยะห่างวันทำการ'),'2');await user.click(screen.getByRole('button',{name:'เพิ่ม Dependency'}));
    await waitFor(()=>expect(mutations('/dependencies').at(-1)?.body).toEqual({predecessorKey:'DE-4',type:'SS',lagDays:2}));
    server.use(http.post(`${issueEndpoint}/dependencies`,()=>failure(409,'dependency_cycle')));await user.click(screen.getByRole('button',{name:'รหัสงานที่เชื่อม'}));await user.click(await screen.findByRole('option',{name:/DE-9/}));await user.click(screen.getByRole('button',{name:'เพิ่ม Dependency'}));await screen.findByText(/req_drawer_test/);
    await user.click(screen.getByRole('button',{name:'ยกเลิก Dependency DE-9'}));await waitFor(()=>expect(f.state.dependencies.blockedBy).toHaveLength(0));
  });
  it('auto-watches through comments, inserts stable mentions, edits and deletes comment',async()=>{
    const user=userEvent.setup();mount();await loaded();await screen.findByText('สร้างงาน');
    await user.type(screen.getByLabelText('เขียนคอมเมนต์'),'สวัสดี @');await user.click(within(screen.getByRole('group',{name:'เลือกสมาชิกที่ต้องการ mention'})).getByRole('button',{name:dev.displayName}));await user.click(screen.getByRole('button',{name:'ส่ง'}));
    await screen.findByRole('button',{name:'แก้คอมเมนต์'});expect(mutations('/comments')[0].body).toEqual({body:`สวัสดี @[${dev.displayName}](${dev.id}) `});expect(f.state.watching).toBe(true);
    await user.click(screen.getByRole('button',{name:'แก้คอมเมนต์'}));await user.clear(screen.getByLabelText('คอมเมนต์'));await user.type(screen.getByLabelText('คอมเมนต์'),'แก้ไขข้อความ');await user.click(within(screen.getByRole('dialog',{name:'แก้คอมเมนต์'})).getByRole('button',{name:'บันทึก'}));await screen.findByText('แก้ไขข้อความ');
    await user.click(screen.getByRole('button',{name:'ลบคอมเมนต์'}));await user.click(within(screen.getByRole('dialog',{name:'ลบคอมเมนต์'})).getByRole('button',{name:'ลบคอมเมนต์'}));await screen.findByText('คอมเมนต์นี้ถูกลบแล้ว');
  });
  it('แยกคอมเมนต์ (กลางหน้า) กับ Activity (กล่องด้านขวา ล่าสุดก่อน แบ่งหน้าได้)',async()=>{
    const user=userEvent.setup();const urls:string[]=[];server.use(http.get(`${issueEndpoint}/activity`,({request})=>{urls.push(request.url);return HttpResponse.json(new URL(request.url).searchParams.has('cursor')?{items:[{id:uid(99),kind:'activity',actor:me,verb:'updated',field:'priority',old:'medium',new:'high',createdAt:'2026-11-06T04:00:00Z'}],nextCursor:null}:{...f.state.feed,nextCursor:'page-two'});}));
    mount();await loaded();const history=await screen.findByRole('region',{name:'Activity'});
    expect(urls[0]).toContain('only=activity');expect(urls[0]).toContain('order=desc');
    await within(history).findByText('สร้างงาน');expect(await screen.findByText('ยังไม่มีคอมเมนต์')).toBeInTheDocument();
    await user.click(within(history).getByRole('button',{name:'โหลดเพิ่ม'}));await within(history).findByText(/Priority: Medium → High/);expect(urls.at(-1)).toContain('cursor=page-two');
  });
  it('Activity ของ Checklist บอกรายการที่เปลี่ยน ไม่ใช่ "ข้อมูลที่เกี่ยวข้อง"',async()=>{
    const item={id:uid(70),text:'ตรวจหน้าจอ',kind:'checklist',done:false};
    f.state.feed.items.push({id:uid(98),kind:'activity',actor:me,verb:'updated',field:'checklist',old:item,new:{...item,done:true},createdAt:'2026-11-06T05:00:00Z'} as never);
    mount();await loaded();const history=await screen.findByRole('region',{name:'Activity'});
    await within(history).findByText('ติ๊ก Checklist “ตรวจหน้าจอ”');
  });
});

describe('Create issue',()=>{
  function createMount(props:Partial<Parameters<typeof IssueDrawerHost>[0]>={}){navigation.search='new=1&filter=open';return mount(undefined,{issueKey:undefined,...props});}
  async function taskFields(user:ReturnType<typeof userEvent.setup>,title='งานที่สร้างใหม่') {
    await screen.findByRole('textbox',{name:'ชื่อ Task'});
    await user.selectOptions(screen.getByLabelText('Module'),uid(10));await user.type(screen.getByLabelText('ชื่อ Task'),title);
  }
  it('creates Task with form-options, required fields and Ctrl+Enter',async()=>{
    const user=userEvent.setup();createMount();await taskFields(user);await user.type(screen.getByLabelText('คำอธิบาย'),'คำอธิบายใหม่');
    fireEvent.keyDown(screen.getByLabelText('ชื่อ Task'),{key:'Enter',ctrlKey:true});
    await waitFor(()=>expect(mutations('/projects/DE/issues')).toHaveLength(1));
    expect(mutations('/projects/DE/issues')[0].body).toMatchObject({type:'Task',title:'งานที่สร้างใหม่',moduleId:uid(10),size:'M',estimateMd:5,description:'คำอธิบายใหม่'});
    await screen.findByRole('button',{name:'งานที่สร้างใหม่'});
    expect(router.replace).toHaveBeenLastCalledWith('/w/sample/p/DE/board?filter=open&issue=DE-20',{scroll:false});
  });
  it('creates Bug with required steps, severity/environment and supplied details',async()=>{
    const user=userEvent.setup();createMount();await user.selectOptions(await screen.findByLabelText('ประเภทงาน'),'Bug');
    await user.type(screen.getByLabelText('ชื่อ Bug'),'Bug ที่พบใหม่');await user.selectOptions(screen.getByLabelText('Severity'),'critical');await user.selectOptions(screen.getByLabelText('Environment'),'uat');
    await user.click(screen.getByRole('button',{name:'สร้างBug'}));expect(mutations('/projects/DE/issues')).toHaveLength(0);
    await user.type(screen.getByLabelText('ขั้นตอนทำซ้ำ *'),'เปิดหน้าแล้วกดปุ่ม');await user.type(screen.getByLabelText('ผลที่ควรเป็น'),'แสดงข้อมูล');await user.type(screen.getByLabelText('ผลที่เกิดขึ้นจริง'),'ข้อมูลไม่แสดง');
    await user.click(screen.getByRole('button',{name:'สร้างBug'}));await waitFor(()=>expect(mutations('/projects/DE/issues')).toHaveLength(1));
    expect(mutations('/projects/DE/issues')[0].body).toMatchObject({type:'Bug',severity:'critical',environment:'uat',details:{steps:'เปิดหน้าแล้วกดปุ่ม',expected:'แสดงข้อมูล',actual:'ข้อมูลไม่แสดง'}});
  });
  it('แก้ข้อความ Checklist ในแถวเดิม: ซ่อนปุ่มเลื่อน/ลบ · Esc ยกเลิก · Enter บันทึก',async()=>{
    const user=userEvent.setup();mount();await loaded();await screen.findByLabelText('ตรวจสอบข้อมูล');
    await user.click(screen.getByRole('button',{name:'ตรวจสอบข้อมูล'}));
    expect(screen.getByLabelText('ข้อความ Checklist')).toHaveFocus();expect(screen.queryByRole('button',{name:'ลบ Checklist ตรวจสอบข้อมูล'})).not.toBeInTheDocument();
    await user.keyboard('{Escape}');expect(screen.queryByLabelText('ข้อความ Checklist')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'ตรวจสอบข้อมูล'}));await user.clear(screen.getByLabelText('ข้อความ Checklist'));await user.type(screen.getByLabelText('ข้อความ Checklist'),'ตรวจข้อมูลใหม่{Enter}');
    await waitFor(()=>expect(f.state.checklist.some((c: { text: string })=>c.text==='ตรวจข้อมูลใหม่')).toBe(true));
  });
  it('creates Story acceptance criteria using the checklist endpoint',async()=>{
    const user=userEvent.setup();createMount();await user.selectOptions(await screen.findByLabelText('ประเภทงาน'),'Story');
    await user.type(screen.getByLabelText('ชื่อ Story'),'Story ตัวอย่าง');await user.type(screen.getByLabelText('ฉันต้องการ *'),'ดูสถานะของงาน');await user.type(screen.getByLabelText('เพิ่ม Acceptance criteria'),'   {Enter}');await user.click(screen.getByRole('button',{name:'สร้างStory'}));await screen.findByText('เพิ่มเกณฑ์การยอมรับอย่างน้อย 1 ข้อ');expect(mutations('/projects/DE/issues')).toHaveLength(0);await user.clear(screen.getByLabelText('เพิ่ม Acceptance criteria'));await user.type(screen.getByLabelText('เพิ่ม Acceptance criteria'),'ดูรายการได้{Enter}กรองสถานะได้{Enter}');await user.click(screen.getByRole('button',{name:'สร้างStory'}));
    await waitFor(()=>expect(mutations('/checklist')).toHaveLength(2));expect(mutations('/checklist').map((m)=>m.body)).toEqual([{text:'ดูรายการได้',kind:'acceptance'},{text:'กรองสถานะได้',kind:'acceptance'}]);
    expect(mutations('/projects/DE/issues')[0].body).toMatchObject({type:'Story',details:{i_want:'ดูสถานะของงาน'}});
  });
  it('creates Spike with numeric timebox',async()=>{
    const user=userEvent.setup();createMount();await user.selectOptions(await screen.findByLabelText('ประเภทงาน'),'Spike');
    await user.type(screen.getByLabelText('ชื่อ Spike'),'Spike ตัวอย่าง');await user.type(screen.getByLabelText('คำถามที่ต้องหาคำตอบ *'),'เลือกแนวทางใด');await user.type(screen.getByLabelText('Timebox (ชั่วโมง) *'),'8');await user.click(screen.getByRole('button',{name:'สร้างSpike'}));
    await waitFor(()=>expect(mutations('/projects/DE/issues')[0]?.body).toMatchObject({type:'Spike',details:{question:'เลือกแนวทางใด',timebox_hours:8}}));
  });
  it('creates a Sub-task from its parent without sending inherited fields',async()=>{
    const user=userEvent.setup();mount();await loaded();await user.click(screen.getByRole('button',{name:'เพิ่ม Sub-task'}));
    const form=await screen.findByRole('dialog',{name:'สร้าง Sub-task'});const props=await within(form).findByRole('complementary',{name:/คุณสมบัติ|Properties/});expect(within(props).getByText('DE-1 · งานตัวอย่าง DE-1')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('ชื่อ Sub-task'),'งานย่อยใหม่');await user.click(within(form).getByRole('button',{name:'สร้างSub-task'}));
    await waitFor(()=>expect(mutations('/projects/DE/issues')).toHaveLength(1));const body=mutations('/projects/DE/issues')[0].body;
    expect(body.parentKey).toBe('DE-1');expect(body).not.toHaveProperty('moduleId');expect(body).not.toHaveProperty('sprintId');
    await screen.findByRole('dialog',{name:'รายละเอียดงาน DE-20'});
  });
  it('retries partial checklist failure without creating main issue or completed child twice',async()=>{
    const user=userEvent.setup();let fail=true;server.use(http.post(`${issueEndpoint}/checklist`,async({request})=>{const body=await request.json() as Record<string,unknown>;if(fail)return failure(500,'temporary_failure');f.state.mutations.push({method:'POST',path:'/api/v1/w/sample/issues/DE-20/checklist',body,etag:null});return HttpResponse.json({id:uid(600),...body},{status:201});}));
    createMount();await taskFields(user);await user.click(screen.getByRole('button',{name:'เพิ่ม Sub-task'}));await user.type(screen.getByLabelText('ชื่อ Sub-task 1'),'งานย่อยพร้อมกัน');await user.type(screen.getByLabelText('เพิ่ม Checklist'),'ตรวจงาน{Enter}');await user.click(screen.getByRole('button',{name:'สร้างTask'}));
    await screen.findByText(/สร้างงานหลัก DE-20 แล้ว/);await screen.findByText(/req_drawer_test/);expect(mutations('/projects/DE/issues')).toHaveLength(2);
    fail=false;await user.click(screen.getByRole('button',{name:'ทำรายการที่เหลือต่อ'}));await screen.findByRole('button',{name:'งานที่สร้างใหม่'});expect(mutations('/projects/DE/issues')).toHaveLength(2);expect(mutations('/checklist')).toHaveLength(1);
  });
  it('keeps a draft for the same user and workspace and isolates other accounts',async()=>{
    const user=userEvent.setup();const view=createMount();await taskFields(user,'แบบร่างส่วนตัว');await user.click(within(screen.getByRole('dialog',{name:/^สร้างงานใหม่/})).getByRole('button',{name:'ปิด'}));
    await screen.findByRole('dialog',{name:'มีข้อมูลที่ยังไม่ได้บันทึก'});await user.click(screen.getByRole('button',{name:'เก็บเป็นแบบร่าง'}));expect(close).toHaveBeenCalledOnce();view.unmount();
    const restored=createMount();await screen.findByText('กู้แบบร่างที่บันทึกไว้บนเครื่องนี้แล้ว');expect(screen.getByLabelText('ชื่อ Task')).toHaveValue('แบบร่างส่วนตัว');
    restored.rerender(<IssueDrawerHost ws="sample" projectKey="DE" meId={dev.id} onClose={close} />);await waitFor(()=>expect(screen.getByLabelText('ชื่อ Task')).toHaveValue(''));expect(screen.queryByText('กู้แบบร่างที่บันทึกไว้บนเครื่องนี้แล้ว')).not.toBeInTheDocument();
  });
  it('type=task opens the B2 drawer (same layout as task detail) with Task / Sub-task toggle',async()=>{
    const user=userEvent.setup();navigation.search='new=1&type=task';mount(undefined,{issueKey:undefined});
    const drawer=await screen.findByRole('dialog',{name:'สร้างงานใหม่'});expect(drawer).toHaveClass('drawer-detail');expect(await within(drawer).findByRole('group',{name:'สร้างเป็น'})).toBeInTheDocument();
    await user.selectOptions(await within(drawer).findByLabelText('Module'),uid(10));await user.type(within(drawer).getByLabelText('ชื่อ Task'),'งานจากตาราง');
    await user.selectOptions(within(drawer).getByLabelText('Priority'),'high');await user.selectOptions(within(drawer).getByLabelText('Size'),'L');
    await user.click(within(drawer).getByRole('button',{name:'สร้างTask'}));
    await waitFor(()=>expect(mutations('/projects/DE/issues')[0]?.body).toMatchObject({type:'Task',title:'งานจากตาราง',priority:'high',size:'L'}));
  });
  it('B adds Requirement / Screen codes, Labels and Watchers and rejects malformed codes',async()=>{
    const user=userEvent.setup();navigation.search='new=1&type=task';mount(undefined,{issueKey:undefined});
    const drawer=await screen.findByRole('dialog',{name:'สร้างงานใหม่'});
    await user.selectOptions(await within(drawer).findByLabelText('Module'),uid(10));await user.type(within(drawer).getByLabelText('ชื่อ Task'),'งานอ้างอิง SRS');
    await user.click(within(drawer).getByRole('button',{name:'+ FR / NFR'}));
    await user.type(within(drawer).getByLabelText('รหัส Requirement'),'REQ 1{Enter}');
    expect(within(drawer).getByRole('alert')).toHaveTextContent('ใช้รูปแบบ FR-02.3 หรือ NFR-01');
    await user.clear(within(drawer).getByLabelText('รหัส Requirement'));await user.type(within(drawer).getByLabelText('รหัส Requirement'),'fr-02.3{Enter}');
    await user.click(within(drawer).getByRole('button',{name:'+ Screen'}));await user.type(within(drawer).getByLabelText('รหัส Screen'),'SCR-203{Enter}');
    expect(within(drawer).getByText('FR-02.3')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button',{name:'ลบ SCR-203'}));
    await user.click(within(drawer).getByRole('button',{name:'+ Screen'}));await user.type(within(drawer).getByLabelText('รหัส Screen'),'scr-107{Enter}');
    await user.click(within(drawer).getByRole('button',{name:'+ Label'}));await user.selectOptions(within(drawer).getByLabelText('เลือก Label'),uid(80));
    expect(within(drawer).getByText('backend')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button',{name:'สร้างTask'}));
    await waitFor(()=>expect(mutations('/projects/DE/issues')[0]?.body).toMatchObject({requirements:['FR-02.3'],screens:['SCR-107'],labelIds:[uid(80)],watcherIds:[]}));
  });
  it('ignores expired drafts and supports creating another item',async()=>{
    const user=userEvent.setup();localStorage.setItem(`friday:issue-draft:sample:DE:${me.id}`,JSON.stringify({expiresAt:1,data:{type:'Task',title:'แบบหมดอายุ'}}));
    createMount();await taskFields(user,'รายการแรก');expect(screen.getByLabelText('ชื่อ Task')).toHaveValue('รายการแรก');await user.click(screen.getByLabelText('สร้างต่ออีกรายการ'));await user.click(screen.getByRole('button',{name:'สร้างTask'}));await screen.findByText('สร้าง DE-20 แล้ว');await waitFor(()=>expect(screen.getByLabelText('ชื่อ Task')).toHaveValue(''));
    await taskFields(user,'รายการที่สอง');await user.click(screen.getByRole('button',{name:'สร้างTask'}));await screen.findByText('สร้าง DE-21 แล้ว');expect(mutations('/projects/DE/issues')).toHaveLength(2);
  });
});

describe('Permissions, state and recovery',()=>{
  it('hides member data and write-only tabs for Guest Viewer while comments remain available',async()=>{
    const user=userEvent.setup();f.state.access={role:'viewer',guestViewer:true,permissions:['project.view','issue.comment']};mount();await loaded();
    expect(screen.queryByRole('tab',{name:'Checklist'})).not.toBeInTheDocument();expect(screen.queryByRole('tab',{name:'Dependency'})).not.toBeInTheDocument();expect(screen.queryByLabelText('ผู้รับผิดชอบ')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'ลบงาน'})).not.toBeInTheDocument();expect(f.state.reads.some((path)=>path.endsWith('/members'))).toBe(false);
    await screen.findByLabelText('เขียนคอมเมนต์');
  });
  it('view-only users cannot mutate and cannot open creation',async()=>{
    f.state.access={role:'viewer',guestViewer:false,permissions:['project.view']};const view=mount();await loaded();expect(screen.getByLabelText('สถานะ')).toBeDisabled();expect(screen.getByRole('button',{name:'งานตัวอย่าง DE-1'})).toBeDisabled();expect(screen.queryByRole('tab',{name:'Checklist'})).not.toBeInTheDocument();expect(f.state.mutations).toHaveLength(0);view.unmount();mount(undefined,{issueKey:undefined});await screen.findByText('คุณยังไม่มีสิทธิ์เข้าถึง');
  });
  it.each([403,404])('handles HTTP%s with the appropriate state',async(status)=>{
    server.use(http.get(issueEndpoint,()=>failure(status,'forbidden')));mount();await screen.findByText(status===403?'คุณยังไม่มีสิทธิ์เข้าถึง':'ไม่พบหน้านี้');expect(screen.queryByLabelText('สถานะ')).not.toBeInTheDocument();
  });
  it('shows network requestId and retry recovers',async()=>{
    const user=userEvent.setup();let failing=true;server.use(http.get(issueEndpoint,()=>failing?failure(500,'failed'):HttpResponse.json(f.state.issues.get('DE-1'))));mount();await screen.findByText(/req_drawer_test/);failing=false;await user.click(screen.getByRole('button',{name:'ลองอีกครั้ง'}));await loaded();
  });
  it('delete impact must load before confirming; delete has an Undo restore',async()=>{
    const user=userEvent.setup();function Example(){const [open,setOpen]=useState(true);return open?<IssueDrawerHost ws="sample" projectKey="DE" meId={me.id} issueKey="DE-1" onClose={()=>{close();setOpen(false);}}/>:null;}renderWithProviders(<Example/>);await loaded();await user.click(screen.getByRole('button',{name:'การทำงานเพิ่มเติม'}));await user.click(await screen.findByRole('button',{name:'ลบงาน'}));const dialog=await screen.findByRole('dialog',{name:/^ลบ DE-1 /});await within(dialog).findByText('Sub-task 2 รายการ · ไฟล์หลักฐาน 1 ไฟล์ · Dependency 1 รายการ');await user.click(within(dialog).getByRole('button',{name:'ลบ Task และ Sub-task 2 รายการ'}));await screen.findByText('ลบ DE-1 แล้ว');expect(close).toHaveBeenCalledOnce();await user.click(screen.getByRole('button',{name:'เลิกทำ'}));await waitFor(()=>expect(mutations('/restore')).toHaveLength(1));expect(f.state.deleted.has('DE-1')).toBe(false);
  });
  it('P3 keep option deletes only the Task and leaves sub-tasks standalone',async()=>{
    const user=userEvent.setup();const urls:string[]=[];server.use(http.delete(issueEndpoint,({request})=>{urls.push(request.url);return HttpResponse.json({key:'DE-1',subtasks:0,keptSubtasks:2});}));mount();await loaded();
    await user.click(screen.getByRole('button',{name:'การทำงานเพิ่มเติม'}));await user.click(await screen.findByRole('button',{name:'ลบงาน'}));
    const dialog=await screen.findByRole('dialog',{name:/^ลบ DE-1 /});await user.click(await within(dialog).findByRole('radio',{name:/เก็บ Sub-task ไว้/}));
    await user.click(within(dialog).getByRole('button',{name:'ลบเฉพาะ Task'}));await waitFor(()=>expect(urls.at(-1)).toContain('subtasks=keep'));
  });
  it('blocks deletion if impact request fails',async()=>{
    const user=userEvent.setup();server.use(http.get(`${issueEndpoint}/delete-impact`,()=>failure(500,'failed')));mount();await loaded();await user.click(screen.getByRole('button',{name:'การทำงานเพิ่มเติม'}));await user.click(await screen.findByRole('button',{name:'ลบงาน'}));await screen.findByText(/req_drawer_test/);expect(screen.getByRole('button',{name:'ลบ 1 งาน'})).toBeDisabled();expect(f.state.mutations).toHaveLength(0);
  });
  it('410 offers restore within the deadline; expired/unauthorized users have no restore button',async()=>{
    const user=userEvent.setup();f.state.deleted.add('DE-1');const view=mount();await screen.findByText('งานนี้ถูกลบแล้ว');await user.click(screen.getByRole('button',{name:'กู้คืนงาน'}));await loaded();view.unmount();server.use(http.get(issueEndpoint,()=>failure(410,'gone',{restorableUntil:'2020-01-01T00:00:00Z'})));mount();await screen.findByText('งานนี้ถูกลบแล้ว');expect(screen.queryByRole('button',{name:'กู้คืนงาน'})).not.toBeInTheDocument();
  });
  it('changing project clears the previous drawer state and cached issue content',async()=>{
    const user=userEvent.setup();const view=mount();await loaded();await screen.findByLabelText('ตรวจสอบข้อมูล');server.use(http.get('*/api/v1/w/other/issues/:key',()=>HttpResponse.json({...f.state.issues.get('DE-9'),key:'XY-9',projectKey:'XY',title:'งานของอีก Workspace'})));
    view.rerender(<IssueDrawerHost ws="other" projectKey="XY" meId={me.id} issueKey="XY-9" onClose={close} />);await screen.findByRole('button',{name:'งานของอีก Workspace'});expect(screen.queryByLabelText('ตรวจสอบข้อมูล')).not.toBeInTheDocument();expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

it('renders configured required fields even when added to another issue type',async()=>{
  const custom=structuredClone(formOptions);custom.issueTypes.find((type)=>type.name==='Task')!.requiredFields.push('steps','severity','environment');server.use(http.get(`${projectEndpoint}/form-options`,()=>HttpResponse.json(custom)));
  const user=userEvent.setup();navigation.search='new=1';mount(undefined,{issueKey:undefined});await screen.findByLabelText('ชื่อ Task');await user.selectOptions(screen.getByLabelText('Module'),uid(10));await user.type(screen.getByLabelText('ชื่อ Task'),'งานที่ต้องกรอกข้อมูลเพิ่ม');
  await user.click(screen.getByRole('button',{name:'สร้างTask'}));expect(mutations('/projects/DE/issues')).toHaveLength(0);await user.type(screen.getByLabelText('ขั้นตอนทำซ้ำ *'),'ขั้นตอนตามที่โปรเจกต์กำหนด');await user.click(screen.getByRole('button',{name:'สร้างTask'}));
  await waitFor(()=>expect(mutations('/projects/DE/issues')[0]?.body).toMatchObject({type:'Task',severity:'major',environment:'sit',details:{steps:'ขั้นตอนตามที่โปรเจกต์กำหนด'}}));
});

it('prefills and submits Table module/phase and Kanban status context', async () => {
  const user = userEvent.setup(); navigation.search = `new=1&type=task&moduleId=${uid(10)}&phaseId=${uid(11)}&statusId=${statuses[1].id}`; mount(undefined, { issueKey: undefined });
  await screen.findByRole('textbox', { name: 'ชื่อ Task' }); expect(screen.getByLabelText('Module')).toHaveValue(uid(10)); expect(screen.getByLabelText('สถานะ')).toHaveValue(statuses[1].id);
  await user.type(screen.getByLabelText('ชื่อ Task'), 'งานในกลุ่มที่เลือก'); await user.click(screen.getByRole('button', { name: 'สร้างTask' })); await waitFor(() => expect(mutations('/projects/DE/issues')).toHaveLength(1)); expect(mutations('/projects/DE/issues')[0].body).toMatchObject({ moduleId: uid(10), phaseId: uid(11), statusId: statuses[1].id });
});
it('ignores unavailable module/phase/status context IDs', async () => {
  navigation.search = 'new=1&type=task&moduleId=unavailable&phaseId=unavailable&statusId=unavailable'; mount(undefined, { issueKey: undefined }); await screen.findByRole('textbox', { name: 'ชื่อ Task' }); expect(screen.getByLabelText('Module')).toHaveValue(''); expect(screen.getByLabelText('สถานะ')).toHaveValue(''); expect(mutations('/projects/DE/issues')).toHaveLength(0);
});
it('gates recording test results on issue.record_test, not issue.edit', async () => {
  f.state.access = { role: 'member', guestViewer: false, permissions: ['project.view', 'issue.record_test'] }; mount('DE-2');
  expect(await screen.findByRole('button', { name: '+ บันทึกผลทดสอบ' })).toBeInTheDocument();
});
it('hides recording test results without issue.record_test', async () => {
  f.state.access = { role: 'member', guestViewer: false, permissions: ['project.view', 'issue.edit'] }; mount('DE-2');
  await screen.findByText('ยังไม่มีผลทดสอบ'); expect(screen.queryByRole('button', { name: '+ บันทึกผลทดสอบ' })).not.toBeInTheDocument();
});
it('keeps the Kanban Bug board when moving between issues', async () => {
  const user = userEvent.setup(); navigation.search = 'type=bug&issue=DE-1'; mount(); await loaded();
  await user.click(screen.getByRole('button', { name: /DE-2.*งานย่อยหนึ่ง/ }));
  await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/w/sample/p/DE/board?type=bug&issue=DE-2', { scroll: false }));
});

it('read-only members see checklist and dependencies without edit controls', async () => {
  f.state.access = { role: 'viewer', guestViewer: false, permissions: ['project.view'] }; mount(); await loaded();
  expect(await screen.findByRole('checkbox', { name: 'ตรวจสอบข้อมูล' })).toBeDisabled();
  expect(await screen.findByRole('button', { name: /DE-9/ })).toBeInTheDocument();
  expect(screen.queryByLabelText('เพิ่ม Checklist')).not.toBeInTheDocument();
  expect(f.state.mutations).toHaveLength(0);
});
it('records a Sub-task test result using the QA API', async () => {
  const user = userEvent.setup(); const runs: unknown[] = [];
  server.use(http.get('*/api/v1/w/:ws/issues/DE-2/test-runs', () => HttpResponse.json({ items: runs })), http.post('*/api/v1/w/:ws/issues/DE-2/test-runs', async ({ request }) => {
    // ผลตรวจของ Reviewer: ผ่าน/ไม่ผ่าน + ผู้ตรวจ + Environment + ขั้นตอนที่พบปัญหา · ไม่มีจำนวนเคส / Commit
    const body = await request.json() as object; expect(body).toMatchObject({ kind: 'qa', result: 'failed', note: 'บันทึกผิดพลาด', environment: 'uat', testerId: me.id }); expect(body).not.toHaveProperty('passedCount'); expect(body).not.toHaveProperty('commitSha');
    const run = { id: uid(400), runNo: 1, createdAt: '2026-11-07T00:00:00Z', tester: me, files: [], bugs: [], commitSha: null, ...body }; runs.push(run); return HttpResponse.json(run, { status: 201 });
  }));
  mount('DE-2'); await user.click(await screen.findByRole('button', { name: '+ บันทึกผลทดสอบ' }));
  expect(screen.getByRole('radiogroup', { name: 'ผลการทดสอบ' })).toBeInTheDocument(); expect(screen.queryByRole('radio', { name: 'ติดเงื่อนไข' })).not.toBeInTheDocument(); expect(screen.queryByLabelText('จำนวนที่ผ่าน')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Commit SHA')).not.toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: 'ไม่ผ่าน' })); await user.selectOptions(screen.getByLabelText('ผู้ตรวจ'), me.id); await user.selectOptions(screen.getByLabelText('Environment'), 'uat');
  await user.type(screen.getByLabelText('ขั้นตอนที่พบปัญหา'), 'บันทึกผิดพลาด'); await user.click(screen.getByRole('button', { name: 'บันทึกผล' })); await screen.findByText('บันทึกผิดพลาด');
  expect(screen.getByText(`ตรวจโดย ${me.displayName}`, { exact: false })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'สร้าง Bug จากผลทดสอบ' })).toBeInTheDocument();
});
it('mobile Sub-task tabs retain the test draft when switching sections', async () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, media: '(max-width: 760px)', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() } as MediaQueryList));
  try {
    const user = userEvent.setup(); mount('DE-2'); await user.click(await screen.findByRole('tab', { name: 'ผลทดสอบ' })); await user.click(await screen.findByRole('button', { name: '+ บันทึกผลทดสอบ' })); await user.type(screen.getByLabelText('บันทึก'), 'ร่างผลทดสอบ'); await user.click(screen.getByRole('tab', { name: 'คอมเมนต์' })); await user.click(screen.getByRole('tab', { name: 'ผลทดสอบ' })); expect(screen.getByLabelText('บันทึก')).toHaveValue('ร่างผลทดสอบ');
  } finally { vi.unstubAllGlobals(); }
});


it('Commits แสดงทุกรายการพร้อมลิงก์ ไม่แสดงแค่ commit ล่าสุด', async () => {
  server.use(http.get('*/api/v1/w/:ws/issues/:key/git', () => HttpResponse.json({ pullRequests: [], commits: [
    { sha: 'abcdef1234567', shortSha: 'abcdef1', message: 'แก้แบบฟอร์ม', author: 'ผู้พัฒนาตัวอย่าง', committedAt: '2026-11-07T00:00:00Z', repository: 'demo/repo', url: 'https://example.com/commit/abcdef1' },
    { sha: 'fedcba1234567', shortSha: 'fedcba1', message: 'เพิ่มการทดสอบ', author: null, committedAt: '2026-11-06T00:00:00Z', repository: 'demo/repo', url: 'https://example.com/commit/fedcba1' },
  ] })));
  mount(); await loaded(); expect(await screen.findByRole('link', { name: 'abcdef1' })).toHaveAttribute('href', 'https://example.com/commit/abcdef1'); expect(screen.getByRole('link', { name: 'fedcba1' })).toHaveAttribute('href', 'https://example.com/commit/fedcba1'); expect(screen.getByText('เพิ่มการทดสอบ')).toBeInTheDocument();
});

describe('Task v2 (ผู้ใช้ตัดสิน 2026-11-08)', () => {
  it('Sub-task เปลี่ยน Task แม่ได้เฉพาะ Task ใน Module เดียวกัน', async () => {
    const user = userEvent.setup();
    f.state.issues.set('DE-7', makeIssue('DE-7', { title: 'Task ใน Module อื่น', moduleId: uid(12) }));
    mount('DE-2'); await screen.findByRole('button', { name: 'งานย่อยหนึ่ง' });
    await user.click(screen.getByRole('button', { name: 'Task แม่' }));
    expect(screen.queryByRole('option', { name: /DE-7/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /DE-9/ }));
    await waitFor(() => expect(mutations('/issues/DE-2').at(-1)).toMatchObject({ body: { parentKey: 'DE-9' } }));
  });

  it('แผงขวาแบ่งผู้รับผิดชอบ / แผนงาน / กลุ่มงาน และไม่มีช่อง Sprint, กลุ่มงานเดิม และ Tester', async () => {
    mount(); await loaded();
    const props = screen.getByRole('complementary', { name: /คุณสมบัติ|Properties/ });
    for (const name of ['ผู้รับผิดชอบ', 'แผนงาน', 'กลุ่มงาน']) expect(within(props).getByRole('region', { name })).toBeInTheDocument();
    expect(within(props).getByRole('combobox', { name: 'System Analyst' })).toBeInTheDocument();
    expect(within(props).getByRole('combobox', { name: 'QA / Reviewer' })).toBeInTheDocument();
    expect(within(props).queryByText('Sprint')).not.toBeInTheDocument();
    expect(within(props).queryByText('Tester')).not.toBeInTheDocument();
  });

  it('Dev แนบผล Unit test พร้อม Coverage ในส่วน Development', async () => {
    const user = userEvent.setup(); const runs: Record<string, unknown>[] = [];
    server.use(http.get('*/api/v1/w/:ws/issues/DE-1/test-runs', () => HttpResponse.json({ items: runs })), http.post('*/api/v1/w/:ws/issues/DE-1/test-runs', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      const run = { id: uid(401), runNo: 1, createdAt: '2026-11-08T00:00:00Z', tester: me, files: [], bugs: [], commitSha: null, environment: null, note: null, passedCount: null, totalCount: null, coveragePct: null, ...body };
      runs.push(run); return HttpResponse.json(run, { status: 201 });
    }));
    mount(); await loaded();
    await user.click(await screen.findByRole('button', { name: '+ แนบผล Unit test' }));
    await user.type(screen.getByLabelText('จำนวนที่ผ่าน'), '48'); await user.type(screen.getByLabelText('จำนวนทั้งหมด'), '48'); await user.type(screen.getByLabelText('Coverage (%)'), '82.5');
    await user.click(screen.getByRole('button', { name: 'บันทึกผล' }));
    await screen.findByText('Coverage 82.5%');
    expect(runs[0]).toMatchObject({ kind: 'unit', result: 'passed', passedCount: 48, totalCount: 48, coveragePct: 82.5 });
    expect(runs[0]).not.toHaveProperty('environment', 'sit');
  });
});

