// ตัวจำลอง Security key (software authenticator) สำหรับ test: ES256, attestation "none"
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const b64u = (b: Buffer) => b.toString('base64url');

/** CBOR encoder เท่าที่ WebAuthn ใช้: จำนวนเต็ม, byte string, text, map */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
  throw new Error('cbor: unsupported');
}

export class SoftKey {
  readonly id = randomBytes(16);
  counter = 0;
  private readonly pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  constructor(private readonly rpId = 'localhost', private readonly origin = 'http://localhost:3002') {}

  private rpHash() {
    return createHash('sha256').update(this.rpId).digest();
  }
  private cose() {
    const jwk = this.pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  }
  private counterBytes() {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    return c;
  }

  /** ตอบ `generateRegistrationOptions` */
  register(options: { challenge: string }, over: { origin?: string } = {}) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: over.origin ?? this.origin, crossOrigin: false }));
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x41]), this.counterBytes(), Buffer.alloc(16), credLen, this.id, this.cose()]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['usb'] } };
  }

  /** ตอบ `generateAuthenticationOptions` · counter เพิ่มทุกครั้ง (หรือกำหนดเอง เพื่อทดสอบการโคลน key) */
  assert(options: { challenge: string }, over: { origin?: string; counter?: number } = {}) {
    this.counter = over.counter ?? this.counter + 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: over.origin ?? this.origin, crossOrigin: false }));
    const authenticatorData = Buffer.concat([this.rpHash(), Buffer.from([0x01]), this.counterBytes()]);
    const signature = createSign('SHA256').update(Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()])).sign(this.pair.privateKey);
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) } };
  }
}
