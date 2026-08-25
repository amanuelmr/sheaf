/**
 * Turning a crop drawn on screen into a crop of the actual image.
 *
 * Kept pure and separate because it is the part that is easy to get quietly
 * wrong: the picture on screen is a scaled, letterboxed, possibly rotated version
 * of the file, and an off-by-a-factor here produces a crop of the wrong part of
 * the page — which looks like a camera bug rather than an arithmetic one.
 *
 * Measured on a real receipt, rotating and cropping took OCR from 56 characters
 * of noise to 257 of readable text. That is what this arithmetic is for.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Quarter turns clockwise. Anything else is not worth the arithmetic. */
export type Rotation = 0 | 90 | 180 | 270;

/** How a rotated image is shaped before it is fitted to the screen. */
export function rotatedSize(image: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: image.height, height: image.width } : image;
}

/**
 * Where a `contain`-fitted image actually sits inside its container, and at what
 * scale. React Native centres and letterboxes it, so the offsets are rarely zero.
 */
export function fitted(
  content: Size,
  container: Size,
): {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly size: Size;
} {
  if (content.width <= 0 || content.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0, size: content };
  }
  const scale = Math.min(container.width / content.width, container.height / content.height);
  const size = { width: content.width * scale, height: content.height * scale };
  return {
    scale,
    offsetX: (container.width - size.width) / 2,
    offsetY: (container.height - size.height) / 2,
    size,
  };
}

/**
 * Map a rectangle drawn in container coordinates onto the *rotated* image.
 *
 * The manipulator rotates before it crops, so the crop is expressed against the
 * rotated image rather than the original — which is the one ordering that makes
 * the two operations composable in a single call.
 */
export function toImageRect(
  selection: Rect,
  container: Size,
  image: Size,
  rotation: Rotation,
): Rect {
  const rotated = rotatedSize(image, rotation);
  const fit = fitted(rotated, container);
  if (fit.scale <= 0) return { x: 0, y: 0, ...rotated };

  const x = (selection.x - fit.offsetX) / fit.scale;
  const y = (selection.y - fit.offsetY) / fit.scale;
  const width = selection.width / fit.scale;
  const height = selection.height / fit.scale;

  return clamp({ x, y, width, height }, rotated);
}

/**
 * Keep a rectangle inside the image and non-degenerate.
 *
 * A crop that runs past the edge is rejected by the native manipulator rather
 * than trimmed, so a drag to the corner would otherwise fail instead of doing the
 * obvious thing.
 */
export function clamp(rect: Rect, bounds: Size): Rect {
  const width = Math.max(1, Math.min(Math.round(rect.width), bounds.width));
  const height = Math.max(1, Math.min(Math.round(rect.height), bounds.height));
  const x = Math.max(0, Math.min(Math.round(rect.x), bounds.width - width));
  const y = Math.max(0, Math.min(Math.round(rect.y), bounds.height - height));
  return { x, y, width, height };
}

/** Quarter turn, staying inside the four legal values. */
export function turn(rotation: Rotation, direction: 1 | -1): Rotation {
  return ((((rotation + direction * 90) % 360) + 360) % 360) as Rotation;
}

/** A selection covering the whole of the fitted image, as a starting point. */
export function fullSelection(container: Size, image: Size, rotation: Rotation): Rect {
  const fit = fitted(rotatedSize(image, rotation), container);
  return { x: fit.offsetX, y: fit.offsetY, width: fit.size.width, height: fit.size.height };
}

/** Is this crop actually asking for less than the whole page? */
export function isMeaningfulCrop(rect: Rect, bounds: Size): boolean {
  // Below a percent or so it is a stray finger, not an intention.
  return rect.width < bounds.width * 0.99 || rect.height < bounds.height * 0.99;
}
