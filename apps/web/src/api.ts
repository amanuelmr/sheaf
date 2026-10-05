import { authorization, paths, type HealthResponse } from '@sheaf/protocol';

export type HealthResult =
  | { readonly ok: true; readonly health: HealthResponse }
  | { readonly ok: false; readonly message: string };

/**
 * One request, no retry logic and no `FailureReason` taxonomy: unlike the sync
 * engine, nothing here decides what to do about a failure, it only has to be
 * shown. Reusing `@sheaf/core`'s machinery for that would be importing a retry
 * budget this page has no use for.
 */
export async function fetchHealth(baseUrl: string, token: string): Promise<HealthResult> {
  try {
    const response = await fetch(new URL(paths.health(), baseUrl), {
      headers: { authorization: authorization(token) },
    });
    if (!response.ok) {
      return { ok: false, message: `${String(response.status)} ${response.statusText}` };
    }
    return { ok: true, health: (await response.json()) as HealthResponse };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
