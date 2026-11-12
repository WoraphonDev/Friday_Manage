/**
 * remark plugin: Enter ครั้งเดียวขึ้นบรรทัดใหม่ตามที่พิมพ์
 * Markdown มาตรฐานรวมบรรทัดที่ติดกันเป็นย่อหน้าเดียว (คั่นด้วยช่องว่าง) ผู้ใช้จึงเห็นคำอธิบายหลายบรรทัดติดกันหลังบันทึก
 * แปลงเฉพาะ text node · โค้ดบล็อกเป็น node ชนิด code จึงไม่โดนแตะ
 */
type MdNode = { type: string; value?: string; children?: MdNode[] };

function splitLines(node: MdNode): MdNode[] {
  if (node.type !== "text" || !node.value?.includes("\n")) {
    if (node.children) node.children = node.children.flatMap(splitLines);
    return [node];
  }
  return node.value.split(/\r?\n/).flatMap((part, index) => [
    ...(index ? [{ type: "break" }] : []),
    ...(part ? [{ type: "text", value: part }] : []),
  ]);
}

export function remarkSoftBreaks() {
  return (tree: MdNode) => { splitLines(tree); };
}
