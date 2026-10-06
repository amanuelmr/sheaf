/** Metro resolves a bundled image to an asset id, which `expo-asset` turns into a file. */
declare module '*.jpg' {
  const assetId: number;
  export default assetId;
}
