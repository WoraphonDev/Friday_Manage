/** จำลองจอมือถือสำหรับ useIsMobile (jsdom ไม่มี matchMedia) · เรียกฟังก์ชันที่คืนมาเพื่อคืนค่าเดิม */
export function asMobile(): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
}
