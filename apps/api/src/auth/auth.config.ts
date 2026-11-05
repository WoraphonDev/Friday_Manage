// ค่าตั้งของ A13 อ่านจาก env ทุกครั้งที่เรียก (ไม่ cache) เพื่อให้ test ตั้ง provider ปลอมก่อนเรียกได้
// config.ts อยู่นอก lane จึงแยกไว้ที่นี่

export type OAuthProviderName = 'google' | 'microsoft';

export interface OAuthProvider {
  name: OAuthProviderName;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
}

const DEV_SECRET = 'friday-dev-auth-secret-not-for-production';

export const isTestEnv = () => process.env.NODE_ENV === 'test';

/** กุญแจหลักสำหรับลงลายมือชื่อ token และเข้ารหัส secret ของ 2FA · production ต้องตั้ง AUTH_SECRET */
export function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('ต้องตั้ง AUTH_SECRET (อย่างน้อย 32 ตัวอักษร) ใน production');
  return DEV_SECRET;
}

/** URL ของหน้าเว็บ ใช้ทำลิงก์ในอีเมลและ redirect หลัง OAuth */
export const webUrl = () => (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
/** URL สาธารณะของ API ใช้ทำ redirect_uri ของ OAuth */
export const apiPublicUrl = () => (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, '');

export const authTimes = {
  verifyEmailMinutes: 24 * 60,
  /** J3: "ลิงก์ใช้ได้ 30 นาที" */
  resetPasswordMinutes: 30,
  changeEmailMinutes: 60,
  resendSeconds: 60,
  mfaTokenMinutes: 5,
  mfaTrustDays: 30,
  oauthStateMinutes: 10,
  /** ใส่รหัส 6 หลักผิดเกินนี้ รหัสนั้นใช้ไม่ได้ ต้องขอใหม่ */
  codeAttempts: 5,
};

const DEFAULTS: Record<OAuthProviderName, Omit<OAuthProvider, 'name' | 'clientId' | 'clientSecret'>> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
  },
  microsoft: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
  },
};

/** null = ยังไม่ได้ตั้ง client id / secret ของ provider นี้ */
export function oauthProvider(name: string): OAuthProvider | null {
  if (name !== 'google' && name !== 'microsoft') return null;
  const p = name.toUpperCase();
  const clientId = process.env[`OAUTH_${p}_CLIENT_ID`];
  const clientSecret = process.env[`OAUTH_${p}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  const d = DEFAULTS[name];
  return {
    name,
    clientId,
    clientSecret,
    authorizeUrl: process.env[`OAUTH_${p}_AUTHORIZE_URL`] ?? d.authorizeUrl,
    tokenUrl: process.env[`OAUTH_${p}_TOKEN_URL`] ?? d.tokenUrl,
    userinfoUrl: process.env[`OAUTH_${p}_USERINFO_URL`] ?? d.userinfoUrl,
    scope: d.scope,
  };
}
