import { describe as suite, expect, it } from 'vitest';
import { underCurrentFolder } from '../src/lib/paths';

const OLD = 'file:///var/mobile/Containers/Data/Application/1B6F0C4E-2D1A-4C3B-9E8F-0A1B2C3D4E5F/';
const NEW = 'file:///var/mobile/Containers/Data/Application/9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D/';

suite('underCurrentFolder', () => {
  it('moves a saved path into the folder the app has after an update', () => {
    expect(underCurrentFolder(`${OLD}Documents/thumbnails/abc.jpg`, `${NEW}Documents/`)).toBe(
      `${NEW}Documents/thumbnails/abc.jpg`,
    );
  });

  it('keeps a path already in the current folder', () => {
    const path = `${NEW}Library/Caches/archive/7.jpg`;
    expect(underCurrentFolder(path, `${NEW}Documents/`)).toBe(path);
  });

  it('leaves paths outside an iOS app folder alone', () => {
    const android = 'file:///data/user/0/dev.sheaf.capture/files/thumbnails/abc.jpg';
    expect(underCurrentFolder(android, 'file:///data/user/0/dev.sheaf.capture/files/')).toBe(
      android,
    );
    expect(underCurrentFolder(`${OLD}Documents/a.jpg`, 'file:///data/user/0/x/files/')).toBe(
      `${OLD}Documents/a.jpg`,
    );
  });
});
