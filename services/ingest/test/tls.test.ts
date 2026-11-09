/** HTTPS of the server's own, and the certificate pin phones are given to trust. */
import { execFileSync, execSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe as suite, expect, it } from 'vitest';
import { isCertificatePin, pairingUri, parsePairingUri, paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Devices } from '../src/devices';
import { createIngestServer } from '../src/server';
import { Storage } from '../src/storage';
import { spkiPin } from '../src/tls';

/**
 * A throwaway self-signed certificate, made by openssl for this run so no private
 * key is ever kept in the repository, and its pin as openssl itself computes it.
 */
const DIR = mkdtempSync(join(tmpdir(), 'sheaf-tls-cert-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    join(DIR, 'key.pem'),
    '-out',
    join(DIR, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=sheaf.test',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'ignore' },
);
const CERT = readFileSync(join(DIR, 'cert.pem'), 'utf8');
const KEY = readFileSync(join(DIR, 'key.pem'), 'utf8');
const OPENSSL_PIN = `sha256/${execSync(
  `openssl x509 -in "${join(DIR, 'cert.pem')}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`,
)
  .toString()
  .trim()}`;
const TOKEN = 'admin-token-tls-pinning';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

suite('the certificate pin', () => {
  it('is the hash of the public key, as openssl computes it', () => {
    expect(spkiPin(CERT)).toBe(OPENSSL_PIN);
    expect(isCertificatePin(OPENSSL_PIN)).toBe(true);
    expect(isCertificatePin('sha256/short=')).toBe(false);
  });

  it('travels in the pairing link, and only for an HTTPS server', () => {
    const link = pairingUri('https://sheaf.home:8787', 'K7QX-ABCD', OPENSSL_PIN);
    expect(parsePairingUri(link)).toEqual({
      server: 'https://sheaf.home:8787',
      code: 'K7QX-ABCD',
      pin: OPENSSL_PIN,
    });
    expect(parsePairingUri(pairingUri('http://sheaf.home', 'K7QX', OPENSSL_PIN))).toBeNull();
    expect(parsePairingUri('sheaf://pair?server=https%3A%2F%2Fa&code=K&pin=nope')).toBeNull();
    expect(parsePairingUri(pairingUri('http://sheaf.home', 'K7QX'))).toEqual({
      server: 'http://sheaf.home',
      code: 'K7QX',
    });
  });
});

suite('serving HTTPS', () => {
  it('answers over TLS with its certificate, and gives the pin with a pairing code', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-tls-')),
    });
    const server = createIngestServer(
      {
        storage,
        token: TOKEN,
        devices: new Devices(driver, { now: () => Date.now() }),
        certificatePin: spkiPin(CERT),
        now: () => Date.now(),
      },
      { cert: CERT, key: KEY },
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    close = () => server.close();
    const port = (server.address() as AddressInfo).port;

    const answer = await new Promise<{ status: number; body: string; pin: string }>(
      (done, fail) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: paths.pairingCodes(),
            headers: { authorization: `Bearer ${TOKEN}` },
            // Trust exactly this self-signed certificate, as a pinned phone does.
            ca: CERT,
            servername: 'localhost',
          },
          (res) => {
            // Read while the connection is open; it is gone once the body ends.
            const peer = (res.socket as TLSSocket).getPeerCertificate();
            const pin = spkiPin(new X509Certificate(peer.raw).toString());
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              done({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                pin,
              });
            });
          },
        );
        req.on('error', fail);
        req.end();
      },
    );
    expect(answer.status).toBe(201);
    expect((JSON.parse(answer.body) as { pin?: string }).pin).toBe(OPENSSL_PIN);
    expect(answer.pin).toBe(OPENSSL_PIN);
  });
});
