import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { USERNAME_PATTERN, type Role } from '@sheaf/protocol';
import type { SignIn, Users } from './users.ts';

export interface SsoOptions {
  /** The provider's issuer URL, as it appears in its tokens. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** This server's callback, registered with the provider: `<server>/v1/sso/callback`. */
  readonly redirectUri: string;
  /** Where the web app is, to send a person back to once signed in. */
  readonly webUrl: string;
  /** The role a person new to Sheaf gets, or null to let only existing linked users in. */
  readonly defaultRole: Role | null;
  /** Which claim names the user: `preferred_username` unless said otherwise. */
  readonly usernameClaim: string;
  readonly name: string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly issuer: string;
}

interface Pending {
  readonly nonce: string;
  readonly verifier: string;
  readonly at: number;
}

const PENDING_MS = 10 * 60_000;
const CLOCK_SKEW_S = 60;

export type SsoResult =
  | (Extract<SignIn, { ok: true }> & { readonly redirect: string })
  | { readonly ok: false; readonly message: string };

/**
 * Single sign-on with an OpenID Connect provider: the authorization code flow with
 * PKCE, state and nonce, and the ID token's signature checked against the
 * provider's published keys before anything in it is believed.
 *
 * A person is matched by the provider's issuer and subject, never by name or
 * email: a provider account called "ann" does not become the Sheaf user "ann"
 * someone made with a password. A person the provider vouches for who has no Sheaf
 * user yet gets one with the default role, unless that is turned off.
 */
export class Sso {
  readonly #options: SsoOptions;
  readonly #users: Users;
  readonly #pending = new Map<string, Pending>();
  #discovery: Discovery | null = null;
  #keys: JsonWebKey[] = [];

  constructor(options: SsoOptions, users: Users) {
    this.#options = options;
    this.#users = users;
  }

  get name(): string {
    return this.#options.name;
  }

  /** Where to send the person to sign in. */
  async start(now: number): Promise<string> {
    const discovery = await this.#discover();
    for (const [state, pending] of this.#pending) {
      if (now - pending.at > PENDING_MS) this.#pending.delete(state);
    }
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.#pending.set(state, { nonce, verifier, at: now });
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.#options.clientId,
      redirect_uri: this.#options.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** The provider sent the person back: check everything, then sign them in. */
  async finish(code: string, state: string, now: number): Promise<SsoResult> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (pending === undefined || now - pending.at > PENDING_MS) {
      return {
        ok: false,
        message: 'that sign-in started too long ago, or somewhere else; try again',
      };
    }
    const discovery = await this.#discover();
    const response = await this.#options.fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.#options.redirectUri,
        client_id: this.#options.clientId,
        client_secret: this.#options.clientSecret,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!response.ok)
      return {
        ok: false,
        message: `the provider refused the sign-in (${String(response.status)})`,
      };
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string')
      return { ok: false, message: 'the provider sent no ID token' };

    const claims = await this.#verify(tokens.id_token);
    if (claims === null)
      return { ok: false, message: 'the ID token is not signed by the provider' };
    const audience = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
    const seconds = now / 1000;
    if (
      claims['iss'] !== discovery.issuer ||
      !audience.includes(this.#options.clientId) ||
      typeof claims['exp'] !== 'number' ||
      claims['exp'] + CLOCK_SKEW_S < seconds ||
      (typeof claims['iat'] === 'number' && claims['iat'] - CLOCK_SKEW_S > seconds) ||
      claims['nonce'] !== pending.nonce ||
      typeof claims['sub'] !== 'string'
    ) {
      return { ok: false, message: 'the ID token is not for this sign-in' };
    }

    const subject = `${discovery.issuer}|${claims['sub']}`;
    let user = await this.#users.bySubject(subject);
    if (user === null) {
      if (this.#options.defaultRole === null) {
        return { ok: false, message: 'there is no Sheaf user for you yet; ask an admin' };
      }
      const wanted = usernameOf(
        claims[this.#options.usernameClaim] ?? claims['email'] ?? claims['sub'],
      );
      const made = await this.#users.createLinked(wanted, this.#options.defaultRole, subject, now);
      if (made === 'taken') {
        return {
          ok: false,
          message: `a Sheaf user named "${wanted}" already signs in with a password; ask an admin`,
        };
      }
      user = made;
    }
    if (user.disabledAt !== null) return { ok: false, message: 'this user is disabled' };
    const session = await this.#users.startSession(user.id, now);
    const back = new URL(this.#options.webUrl);
    // In the fragment, which browsers never send to a server or in a Referer.
    back.hash = new URLSearchParams({
      sso: session.token,
      server: new URL(this.#options.redirectUri).origin,
    }).toString();
    return { ...session, redirect: back.toString() };
  }

  async #discover(): Promise<Discovery> {
    if (this.#discovery !== null) return this.#discovery;
    const url = `${this.#options.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await this.#options.fetch(url);
    if (!response.ok) throw new Error(`could not read ${url}: ${String(response.status)}`);
    this.#discovery = (await response.json()) as Discovery;
    return this.#discovery;
  }

  /** The token's claims if its signature checks out against one of the provider's keys. */
  async #verify(jwt: string): Promise<Record<string, unknown> | null> {
    const [head, body, signature] = jwt.split('.');
    if (head === undefined || body === undefined || signature === undefined) return null;
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(head, 'base64url').toString()) as typeof header;
      claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const algorithms: Record<string, { hash: string; ec: boolean }> = {
      RS256: { hash: 'sha256', ec: false },
      ES256: { hash: 'sha256', ec: true },
    };
    const algorithm = algorithms[header.alg ?? ''];
    if (algorithm === undefined) return null; // never "none", never a shared secret
    for (const refresh of [false, true]) {
      if (refresh || this.#keys.length === 0) await this.#loadKeys();
      const key = this.#keys.find((k) => header.kid === undefined || k.kid === header.kid);
      if (key === undefined) continue;
      const ok = verify(
        algorithm.hash,
        Buffer.from(`${head}.${body}`),
        {
          key: createPublicKey({ key: key, format: 'jwk' }),
          ...(algorithm.ec ? { dsaEncoding: 'ieee-p1363' as const } : {}),
        },
        Buffer.from(signature, 'base64url'),
      );
      return ok ? claims : null;
    }
    return null;
  }

  async #loadKeys(): Promise<void> {
    const discovery = await this.#discover();
    const response = await this.#options.fetch(discovery.jwks_uri);
    if (!response.ok)
      throw new Error(`could not read the provider's keys: ${String(response.status)}`);
    this.#keys = ((await response.json()) as { keys: JsonWebKey[] }).keys;
  }
}

/** A provider's name for someone, made into a Sheaf username. */
export function usernameOf(value: unknown): string {
  const raw = typeof value === 'string' ? value : 'user';
  let name = raw
    .toLowerCase()
    .split('@')[0]!
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  name = name.slice(0, 32);
  if (!USERNAME_PATTERN.test(name))
    name = `user-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
  return name;
}
