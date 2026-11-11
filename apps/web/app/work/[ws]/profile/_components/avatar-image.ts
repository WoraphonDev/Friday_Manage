/** ขนาดรูปโปรไฟล์ที่ส่งขึ้น API (แสดงใหญ่สุด 96px · เผื่อจอความละเอียดสูง) */
export const AVATAR_SIZE = 256;
/** รูปต้นฉบับใหญ่สุดที่ยอมเปิดในเบราว์เซอร์ (ย่อแล้วเหลือราว 20–60 KB) */
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * ครอปกลางเป็นสี่เหลี่ยมจัตุรัสแล้วย่อเป็น 256×256 · วาดใหม่ลง canvas จึงตัดข้อมูลแฝง (EXIF เช่นพิกัด GPS) ทิ้งไปด้วย
 * เบราว์เซอร์ที่สร้าง WebP ไม่ได้ (Safari รุ่นเก่า) ใช้ JPEG แทน
 */
export async function squareAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.imageSmoothingQuality = "high";
    // รูปโปร่งใสเป็น JPEG จะกลายเป็นพื้นดำ จึงรองพื้นขาวไว้ก่อน
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const webp = await toBlob(canvas, "image/webp", 0.86);
    if (webp && webp.type === "image/webp") return webp;
    const jpeg = await toBlob(canvas, "image/jpeg", 0.88);
    if (!jpeg) throw new Error("encode");
    return jpeg;
  } finally {
    bitmap.close();
  }
}
