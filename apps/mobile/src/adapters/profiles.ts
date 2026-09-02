import * as SecureStore from 'expo-secure-store';
import { clearServerConfig, loadServerConfig } from './credentials';

/**
 * More than one named Paperless connection on one phone -- "home" and "work",
 * say -- each with its own local event log (see `databaseNameFor`). Everything
 * that is not a secret (the list, which one is active) lives in the keystore
 * too rather than a plain file: none of it needs the extra step of encrypting a
 * database column just for the profile name.
 */
export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
}

export interface Profile extends ProfileSummary {
  readonly token: string;
}

const PROFILES_KEY = 'sheaf.profiles';
const ACTIVE_KEY = 'sheaf.activeProfile';

/**
 * Every install before profiles existed. Kept as a fixed id rather than one
 * generated at migration time so its database keeps the filename every
 * existing install already has captures in -- see `databaseNameFor`.
 */
const DEFAULT_PROFILE_ID = 'default';

const tokenKey = (id: string): string => `sheaf.profile.${id}.token`;

/** The database file a profile's own event log and archive cache live in. */
export function databaseNameFor(profileId: string): string {
  return profileId === DEFAULT_PROFILE_ID ? 'sheaf.db' : `sheaf-${profileId}.db`;
}

async function readProfileList(): Promise<ProfileSummary[]> {
  const raw = await SecureStore.getItemAsync(PROFILES_KEY);
  return raw === null ? [] : (JSON.parse(raw) as ProfileSummary[]);
}

async function writeProfileList(profiles: readonly ProfileSummary[]): Promise<void> {
  await SecureStore.setItemAsync(PROFILES_KEY, JSON.stringify(profiles));
}

export async function listProfiles(): Promise<readonly ProfileSummary[]> {
  return readProfileList();
}

export function activeProfileId(): Promise<string | null> {
  return SecureStore.getItemAsync(ACTIVE_KEY);
}

export async function setActiveProfile(id: string): Promise<void> {
  await SecureStore.setItemAsync(ACTIVE_KEY, id);
}

export async function loadProfile(id: string): Promise<Profile | null> {
  const summary = (await readProfileList()).find((p) => p.id === id);
  if (summary === undefined) return null;
  const token = await SecureStore.getItemAsync(tokenKey(id));
  if (token === null) return null;
  return { ...summary, token };
}

export async function loadActiveProfile(): Promise<Profile | null> {
  const id = await activeProfileId();
  return id === null ? null : loadProfile(id);
}

async function createProfile(
  id: string,
  input: { readonly name: string; readonly baseUrl: string; readonly token: string },
): Promise<Profile> {
  const summary: ProfileSummary = { id, name: input.name, baseUrl: input.baseUrl };
  const summaries = await readProfileList();
  await writeProfileList([...summaries.filter((p) => p.id !== id), summary]);
  await SecureStore.setItemAsync(tokenKey(id), input.token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await setActiveProfile(id);
  return { ...summary, token: input.token };
}

function generateProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a new profile and make it the active one. */
export function addProfile(input: {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
}): Promise<Profile> {
  return createProfile(generateProfileId(), input);
}

/**
 * Forget a profile: its token, and its place in the list. The database file its
 * own event log lives in is left alone -- removing a profile disconnects from a
 * server, it does not delete what was already captured through it, the same
 * restraint `disconnect` already had before profiles existed.
 */
export async function removeProfile(id: string): Promise<void> {
  await writeProfileList((await readProfileList()).filter((p) => p.id !== id));
  await SecureStore.deleteItemAsync(tokenKey(id));
  if ((await activeProfileId()) === id) await SecureStore.deleteItemAsync(ACTIVE_KEY);
}

/**
 * One-shot: carry forward whoever was already connected before profiles
 * existed, as the `default` profile, so this update cannot orphan a single
 * existing install's captures. Guarded on the profile list being empty rather
 * than on some "already migrated" flag, because an empty list is the actual
 * thing that would otherwise mean losing track of that connection -- and it
 * stays empty forever after, whether from a fresh install or a deliberate
 * `removeProfile`.
 */
export async function migrateLegacyConnection(): Promise<void> {
  if ((await readProfileList()).length > 0) return;
  const legacy = await loadServerConfig();
  if (legacy === null) return;
  await createProfile(DEFAULT_PROFILE_ID, {
    name: legacy.baseUrl.replace(/^https?:\/\//, ''),
    baseUrl: legacy.baseUrl,
    token: legacy.token,
  });
  await clearServerConfig();
}
