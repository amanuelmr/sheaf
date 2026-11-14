/**
 * iOS moves an app's data folder when the app is updated or reinstalled: the files
 * stay, but under a new folder id, so a saved `file://` path to them stops working.
 * This puts a saved path under the folder the app has now. Paths without an iOS
 * app folder, such as Android's, never move and come back unchanged.
 */
const APP_FOLDER = /\/Containers\/Data\/Application\/[0-9A-Fa-f-]+\//;

export function underCurrentFolder(saved: string, current: string): string {
  const now = APP_FOLDER.exec(current);
  return now === null ? saved : saved.replace(APP_FOLDER, now[0]);
}
