/**
 * Only this app's own scripts and styles may run. Requests may go to any server,
 * since a person chooses theirs; documents are shown from blob URLs, made only
 * for real PDFs.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' http: https:",
  'frame-src blob:',
  // A PDF in a frame is drawn by the browser's own viewer, which counts as an object.
  'object-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
