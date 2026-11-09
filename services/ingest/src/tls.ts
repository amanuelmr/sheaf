import { createHash, X509Certificate } from 'node:crypto';

/**
 * A certificate's public key pin, as `sha256/<base64>`: the SHA-256 of its
 * SubjectPublicKeyInfo, the form OkHttp, TrustKit and HPKP all use. It names the
 * key rather than the certificate, so renewing with the same key keeps the pin.
 */
export function spkiPin(certificatePem: string): string {
  const key = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
  return `sha256/${createHash('sha256').update(key).digest('base64')}`;
}
