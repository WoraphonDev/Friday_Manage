import { CookieConsent } from "./_components/cookie-consent";

/** หน้าสาธารณะ (R1, R4) ถามความยินยอมคุกกี้ · ในแอปหลังล็อกอินใช้เฉพาะคุกกี้ที่จำเป็น */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CookieConsent />
    </>
  );
}
