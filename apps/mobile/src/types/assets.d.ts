/**
 * Metro resolves a bundled image to an asset id, which `expo-asset` turns into a
 * file. Declared per extension because Metro picks the loader from the extension,
 * so the next `.png` should typecheck rather than fail with a baffling message.
 */
type AssetId = number;

declare module '*.jpg' {
  const assetId: AssetId;
  export default assetId;
}
declare module '*.jpeg' {
  const assetId: AssetId;
  export default assetId;
}
declare module '*.png' {
  const assetId: AssetId;
  export default assetId;
}
declare module '*.gif' {
  const assetId: AssetId;
  export default assetId;
}
declare module '*.webp' {
  const assetId: AssetId;
  export default assetId;
}
declare module '*.bmp' {
  const assetId: AssetId;
  export default assetId;
}
declare module '*.svg' {
  const assetId: AssetId;
  export default assetId;
}
