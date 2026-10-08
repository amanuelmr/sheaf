import { Asset } from 'expo-asset';
import DocumentScanner, {
  ResponseType,
  ScanDocumentResponseStatus,
} from 'react-native-document-scanner-plugin';
import fixturePage from '../../assets/e2e/page.jpg';

/**
 * End-to-end test builds scan a bundled page instead of opening a camera, because
 * a simulator has no camera to open. Expo inlines `EXPO_PUBLIC_*` variables when
 * it bundles, so in any build made without this flag the branch is dead code and
 * no setting at runtime can turn it on.
 *
 * The import above is unconditional, though, so Metro does emit the 21 KB fixture
 * into every export including release builds. That is the cost of a test path this
 * app can exercise end to end; the branch itself still cannot run. If the bytes
 * ever matter more than the coverage, move this import behind a dev-only entry.
 */
const E2E = process.env.EXPO_PUBLIC_SHEAF_E2E === '1';

/**
 * Reads the bundled page. Inside the caller's try, like every other way this can
 * fail: `downloadAsync` rejects on a missing or unreadable asset, and a test-only
 * branch must not be the one path that throws instead of reporting `unavailable`.
 */
async function fixtureScan(): Promise<ScanOutcome> {
  const asset = await Asset.fromModule(fixturePage).downloadAsync();
  if (asset.localUri === null) return { kind: 'unavailable', detail: 'fixture page missing' };
  return { kind: 'pages', uris: [asset.localUri] };
}

export type ScanOutcome =
  | { readonly kind: 'pages'; readonly uris: readonly string[] }
  | { readonly kind: 'cancelled' }
  /** The platform scanner is not usable here; the caller should fall back. */
  | { readonly kind: 'unavailable'; readonly detail: string };

/**
 * The platform's own document scanner — VisionKit on iOS, ML Kit on Android.
 *
 * Using it rather than our own camera is the single biggest quality decision in
 * the app. It finds the page in the frame, corrects the perspective, enhances the
 * contrast, and handles multiple pages and retakes, in a UI people already know
 * from Notes. Writing a worse quad-detector was the alternative, and measurements
 * were unambiguous about what un-straightened pages cost: the same receipt read as
 * 56 characters of OCR noise before any correction and 257 after.
 *
 * It returns pages already cropped, so nothing downstream changes — they go into
 * the same assemble-hash-upload pipeline as before.
 */
export async function scanDocument(quality = 100): Promise<ScanOutcome> {
  try {
    // Inside the try on purpose: every failure below is reported as `unavailable`
    // rather than thrown, and the test-only branch keeps that contract too.
    if (E2E) return await fixtureScan();

    const result = await DocumentScanner.scanDocument({
      croppedImageQuality: quality,
      responseType: ResponseType.ImageFilePath,
    });

    if (result.status === ScanDocumentResponseStatus.Cancel) return { kind: 'cancelled' };

    const uris = result.scannedImages ?? [];
    // Cancelling can also surface as a success with nothing in it.
    if (uris.length === 0) return { kind: 'cancelled' };
    return { kind: 'pages', uris };
  } catch (error) {
    return {
      kind: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
