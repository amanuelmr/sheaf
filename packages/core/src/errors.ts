import type { FailureReason } from './events';

/** A failure whose remedy is time. */
export function isRetryable(reason: FailureReason): boolean {
  switch (reason.kind) {
    case 'unreachable':
    case 'server_error':
    case 'rate_limited':
      return true;
    case 'auth':
    case 'not_found':
    case 'tls':
    case 'too_large':
    case 'rejected':
      return false;
  }
}

/** A failure whose remedy is the user changing something in Settings. */
export function isBlocking(reason: FailureReason): boolean {
  switch (reason.kind) {
    case 'auth':
    case 'not_found':
    case 'tls':
      return true;
    case 'unreachable':
    case 'server_error':
    case 'rate_limited':
    case 'too_large':
    case 'rejected':
      return false;
  }
}

export type UserAction = 'retry' | 'check_server_settings' | 'check_token' | 'view_details';

/**
 * Every error must answer three questions: what happened, is my document safe,
 * and what can I do. That contract is encoded in this type, so no screen can
 * render a bare "Something went wrong".
 */
export interface UserFacingError {
  /** What happened, in plain language. */
  readonly title: string;
  /** Is my document safe? Always answered. */
  readonly reassurance: string;
  readonly actions: readonly UserAction[];
  /** Kept for the "Advanced details" disclosure. Never shown first. */
  readonly technical: string;
}

const SAFE = 'Your document is safe on this device.';

export function describe(reason: FailureReason): UserFacingError {
  switch (reason.kind) {
    case 'unreachable':
      return {
        title: "Couldn't reach your server.",
        reassurance: `${SAFE} We'll try again automatically.`,
        actions: ['retry', 'view_details'],
        technical: 'Network request failed before a response was received.',
      };
    case 'server_error':
      return {
        title: 'Your server ran into a problem.',
        reassurance: `${SAFE} We'll try again automatically.`,
        actions: ['retry', 'view_details'],
        technical: `HTTP ${reason.status}`,
      };
    case 'rate_limited':
      return {
        title: 'Your server asked us to slow down.',
        reassurance: `${SAFE} We'll try again shortly.`,
        actions: ['view_details'],
        technical: `HTTP 429${reason.retryAfterMs === undefined ? '' : ` retry-after=${reason.retryAfterMs}ms`}`,
      };
    case 'auth':
      return {
        title: "We couldn't sign in to your server.",
        reassurance: `${SAFE} Nothing will be sent until this is fixed.`,
        actions: ['check_token', 'view_details'],
        technical: `HTTP ${reason.status}`,
      };
    case 'not_found':
      return {
        title: "That address doesn't look like a Sheaf server.",
        reassurance: `${SAFE} Nothing will be sent until this is fixed.`,
        actions: ['check_server_settings', 'view_details'],
        technical: 'HTTP 404 from the documents endpoint.',
      };
    case 'tls':
      return {
        title: "We couldn't verify your server's certificate.",
        reassurance: `${SAFE} We stopped rather than send it over an untrusted connection.`,
        actions: ['check_server_settings', 'view_details'],
        technical: reason.detail,
      };
    case 'too_large':
      return {
        title: 'This document is larger than your server accepts.',
        reassurance: `${SAFE} Try scanning fewer pages at a time, or lower the image quality.`,
        actions: ['view_details'],
        technical: 'HTTP 413',
      };
    case 'rejected':
      return {
        title: 'Your server declined this document.',
        reassurance: SAFE,
        actions: ['retry', 'view_details'],
        technical: `HTTP ${reason.status}: ${reason.message}`,
      };
  }
}
