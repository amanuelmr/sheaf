/** Single sign-on against an OpenID Connect provider of our own making. */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { handle, type IngestRequest } from '../src/router';
import { Sso, usernameOf, type SsoOptions } from '../src/sso';
import { Storage } from '../src/storage';
import { Users } from '../src/users';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ISSUER = 'https://id.example.com';
const NOW = 1_700_000_000_000;

let provider: { privateKey: KeyObject; publicKey: KeyObject };
let forger: { privateKey: KeyObject };
let claims: Record<string, unknown>;
let signer: KeyObject;
let users: Users;
let deps: Parameters<typeof handle>[1];
let options: SsoOptions;
/** What the fake provider says about itself and its key; a test may change them. */
let discoveredIssuer: string;
let keyUse: string;

function jwt(payload: Record<string, unknown>, key: KeyObject): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

/** The provider's three endpoints, answering as a real one would. */
const fakeFetch: SsoOptions['fetch'] = (url, init) => {
  const json = (value: unknown) =>
    Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return json({
      issuer: discoveredIssuer,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/keys`,
    });
  }
  if (url === `${ISSUER}/keys`) {
    return json({
      keys: [
        { ...provider.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: keyUse },
      ],
    });
  }
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(init?.body as string);
    if (form.get('code') !== 'good-code' || form.get('code_verifier') === null) {
      return Promise.resolve(new Response('{}', { status: 400 }));
    }
    return json({ id_token: jwt(claims, signer) });
  }
  return Promise.resolve(new Response('', { status: 404 }));
};

const req = (method: string, path: string, query = ''): IngestRequest => ({
  method,
  path,
  query,
  headers: {},
  body: new Uint8Array(),
});

async function signInFlow(start = ''): Promise<{
  status: number;
  location: string | undefined;
  detail: string | undefined;
}> {
  const started = await handle(req('GET', paths.ssoStart(), start), deps);
  const location = new URL(started.headers!['location']!);
  const params = location.searchParams;
  expect(params.get('code_challenge_method')).toBe('S256');
  claims = { ...claims, nonce: claims['nonce'] === 'keep-wrong' ? 'wrong' : params.get('nonce') };
  const back = await handle(
    req(
      'GET',
      paths.ssoCallback(),
      new URLSearchParams({ code: 'good-code', state: params.get('state')! }).toString(),
    ),
    deps,
  );
  return {
    status: back.status,
    location: back.headers?.['location'],
    detail: (back.json as { detail?: string } | undefined)?.detail,
  };
}

beforeEach(async () => {
  provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
  forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  signer = provider.privateKey;
  discoveredIssuer = ISSUER;
  keyUse = 'sig';
  claims = {
    iss: ISSUER,
    aud: 'sheaf',
    sub: 'u-1',
    exp: NOW / 1000 + 300,
    iat: NOW / 1000,
    preferred_username: 'Ann.Smith',
    email: 'Ann.Smith@Example.com',
    email_verified: true,
  };
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-sso-')),
  });
  users = new Users(driver);
  options = {
    issuer: ISSUER,
    clientId: 'sheaf',
    clientSecret: 'shh',
    redirectUri: 'https://sheaf.example.com/v1/sso/callback',
    webUrl: 'https://sheaf.example.com/app/',
    defaultRole: 'viewer',
    allowedEmails: ['@example.com'],
    usernameClaim: 'preferred_username',
    name: 'Example ID',
    fetch: fakeFetch,
  };
  deps = {
    storage,
    token: 'admin-token-for-sso',
    now: () => NOW,
    users,
    sso: new Sso(options, users),
  };
});

suite('single sign-on', () => {
  it('signs a person in, making their user the first time, and hands the web app a token', async () => {
    expect((await handle(req('GET', paths.sso()), deps)).json).toEqual({
      enabled: true,
      name: 'Example ID',
    });
    const first = await signInFlow();
    expect(first.status).toBe(302);
    const fragment = new URLSearchParams(new URL(first.location!).hash.slice(1));
    expect(fragment.get('server')).toBe('https://sheaf.example.com');
    const me = await handle(
      { ...req('GET', paths.me()), headers: { authorization: `Bearer ${fragment.get('sso')!}` } },
      deps,
    );
    expect(me.json).toMatchObject({ kind: 'user', role: 'viewer', name: 'ann.smith' });
    await signInFlow();
    expect((await users.list()).map((u) => u.username)).toEqual(['ann.smith']);
  });

  it('refuses a token not signed by the provider, or not for this sign-in', async () => {
    signer = forger.privateKey;
    expect((await signInFlow()).status).toBe(401);
    signer = provider.privateKey;
    claims = { ...claims, nonce: 'keep-wrong' };
    expect((await signInFlow()).detail).toMatch(/not for this sign-in/);
    claims = { ...claims, nonce: undefined, aud: 'someone-else' };
    expect((await signInFlow()).status).toBe(401);
    expect(await users.list()).toEqual([]);
  });

  it('never lets a provider account take over a password user of the same name', async () => {
    await users.create({ username: 'ann.smith', password: 'a long password', role: 'admin' }, NOW);
    const result = await signInFlow();
    expect(result.status).toBe(401);
    expect(result.detail).toMatch(/already signs in with a password/);
  });

  it('refuses a state it did not hand out, and a replayed one', async () => {
    const back = await handle(
      req('GET', paths.ssoCallback(), 'code=good-code&state=made-up'),
      deps,
    );
    expect(back.status).toBe(401);
  });

  it('makes a new user only for a verified email on the allowed list', async () => {
    const refused = async (change: Record<string, unknown>, allowed = ['@example.com']) => {
      deps = { ...deps, sso: new Sso({ ...options, allowedEmails: allowed }, users) };
      claims = { ...claims, ...change };
      const result = await signInFlow();
      return result.status === 401 && /no Sheaf user for you yet/.test(result.detail ?? '');
    };
    expect(await refused({ email_verified: false })).toBe(true);
    expect(await refused({ email_verified: true, email: 'ann@example.com.evil.net' })).toBe(true);
    expect(await refused({ email: undefined })).toBe(true);
    expect(await refused({ email: 'ann@example.com' }, [])).toBe(true);
    expect(await users.list()).toEqual([]);
    expect(await refused({}, ['ann@example.com'])).toBe(false);
  });

  it('still lets in a user linked already, with no list at all', async () => {
    expect((await signInFlow()).status).toBe(302);
    deps = { ...deps, sso: new Sso({ ...options, allowedEmails: [] }, users) };
    claims = { ...claims, email_verified: false };
    expect((await signInFlow()).status).toBe(302);
  });

  it('refuses a provider whose discovery names another issuer', async () => {
    discoveredIssuer = 'https://evil.example.net';
    const started = await handle(req('GET', paths.ssoStart()), deps);
    expect(started.status).toBe(500);
  });

  it('checks a token only with a key meant for signing', async () => {
    keyUse = 'enc';
    expect((await signInFlow()).status).toBe(401);
    expect(await users.list()).toEqual([]);
  });

  it('hands the web app back the value it started the sign-in with', async () => {
    const client = 'the-web-apps-own-value-123';
    const result = await signInFlow(`client=${client}`);
    const fragment = new URLSearchParams(new URL(result.location!).hash.slice(1));
    expect(fragment.get('client')).toBe(client);
    expect((await handle(req('GET', paths.ssoStart(), 'client=short'), deps)).status).toBe(400);
  });

  it('makes provider names into usernames', () => {
    expect(usernameOf('Ann.Smith')).toBe('ann.smith');
    expect(usernameOf('ann@example.com')).toBe('ann');
    expect(usernameOf('Zoë Ünal')).toBe('zo-nal');
    expect(usernameOf('!!')).toMatch(/^user-[0-9a-f]{8}$/);
  });
});
