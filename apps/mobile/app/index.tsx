import { useCallback, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link, useRouter } from 'expo-router';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { assemble, mostSimilarPage, pageHash } from '@sheaf/pdf';
import type { PageRef } from '@sheaf/core';
import { pendingCount } from '@sheaf/store';
import { useApp } from '../src/runtime/app-context';
import { readPageBytes, storeThumbnail, writePdf } from '../src/adapters/files';
import { scanDocument } from '../src/adapters/scanner';
import { timeAgo } from '../src/lib/format';
import { radius, spacing, TOUCH_TARGET } from '../src/theme';
import { Button } from '../src/ui/components';
import { PageEditor, type EditedPage } from '../src/ui/page-editor';

interface PendingPage {
  readonly ref: PageRef;
  readonly bytes: Uint8Array;
}

/**
 * A small copy of the first page, so a list of documents is recognisable.
 *
 * Best effort on purpose: a capture must never fail because a preview could not
 * be made. Worst case the outbox shows a placeholder.
 *
 * It also carries the bytes back out, because the same small image answers a second
 * question. Recognising a page photographed twice needs pixels, and decoding a
 * twelve-megapixel original to get them costs around a hundred times more work than
 * decoding this -- for an answer computed on a 16x16 grid, which cannot tell the
 * difference. The measurements that set the threshold were made at roughly this
 * size, so this is the size it is best evidenced at as well.
 */
async function makeThumbnail(
  sha256: string,
  pageUri: string,
): Promise<{ path: string; bytes: Uint8Array } | null> {
  try {
    const context = ImageManipulator.manipulate(pageUri);
    context.resize({ width: 320 });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.6 });
    const bytes = await readPageBytes(saved.uri);
    return { path: await storeThumbnail(sha256, saved.uri), bytes };
  } catch {
    return null;
  }
}

/**
 * The shutter. The app opens here, with nothing in front of the camera.
 *
 * A tap commits the document and hands it to the sync loop immediately — there is
 * no review step to pass, because the point of the product is that capture never
 * waits for a human.
 *
 * The camera being the root screen means there is no back gesture, so the way out
 * has to be visible on the screen itself. An earlier version put those links in
 * small grey text over the preview, and hid the outbox behind a sentence that read
 * as a status rather than a control ("Everything is synced") — which left people
 * feeling trapped in a camera. The bottom bar below is now always present, always
 * looks tappable, and keeps the shutter as the largest thing on screen.
 */
export default function Shutter() {
  const { palette, outbox, offline, service, settings, server, refresh } = useApp();
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const camera = useRef<CameraView>(null);
  const router = useRouter();

  const [pages, setPages] = useState<readonly PendingPage[]>([]);
  // A page waiting to be straightened and trimmed. Capture is not finished until
  // this is resolved, but nothing here asks the user about metadata.
  const [editing, setEditing] = useState<{ page: EditedPage; keepGoing: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  /** Set only when the platform scanner could not run. */
  const [manual, setManual] = useState(false);
  /**
   * A notice may point at an earlier document, when this capture looked like one.
   * It never blocks: the document is already saved either way.
   */
  const [notice, setNotice] = useState<{ text: string; docId?: string } | null>(null);

  const waiting = pendingCount(outbox);

  const commit = useCallback(
    async (collected: readonly PendingPage[]) => {
      if (collected.length === 0 || service === null) return;
      const result = assemble(
        collected.map((page) => page.bytes),
        { dpi: settings.dpi },
      );
      if (!result.ok) {
        setNotice({ text: 'That page couldn’t be read. Try again.' });
        return;
      }

      // The bytes land on disk before the event does, so a log entry never
      // describes a document that is not there.
      const file = writePdf(result.sha256, result.bytes);
      const preview = await makeThumbnail(result.sha256, collected[0]!.ref.path);

      // Does this look like something already captured? Asked before committing, so
      // the answer cannot be the document we are about to add. A photograph of the
      // same page never produces the same bytes, so the content hash has nothing to
      // say about it -- this is the only part of the system that does.
      const look = preview === null ? null : pageHash(preview.bytes);
      const familiar =
        look === null
          ? null
          : mostSimilarPage(
              look,
              outbox.map((row) => ({ pageHash: row.pageHash, value: row })),
            );
      const outcome = await service.sync.capture({
        docId: result.sha256,
        sha256: result.sha256,
        bytes: file.size ?? result.bytes.length,
        pages: collected.map((page) => page.ref),
        ...(preview === null ? {} : { thumbnailPath: preview.path }),
        ...(look === null ? {} : { pageHash: look }),
      });
      setPages([]);

      if (outcome.kind === 'already-captured') {
        setNotice({
          text:
            outcome.state.status === 'SYNCED'
              ? 'You’ve scanned this one already — it’s on your server.'
              : 'You’ve scanned this one already — it’s still on its way.',
        });
        return;
      }

      const saved = offline
        ? 'Saved on this device. It’ll sync when your server is reachable.'
        : 'Saved. On its way to your server.';

      // Said as an observation, not an accusation, and only after the document is
      // safely committed. Being wrong here costs a moment's attention; refusing a
      // capture over it would cost a document.
      setNotice(
        familiar === null
          ? { text: saved }
          : {
              text: `${saved} This looks like the one you scanned ${timeAgo(
                familiar.value.createdAt,
                Date.now(),
              )} — tap to compare.`,
              docId: familiar.value.docId,
            },
      );
      await service.tick();
      await refresh();
    },
    [service, settings.dpi, offline, outbox, refresh],
  );

  /**
   * The primary path: hand over to the platform scanner, which finds the page,
   * straightens it and returns pages already cropped. Multiple pages and retakes
   * happen inside its own UI, so there is nothing to collect here.
   */
  const scan = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await scanDocument();
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'unavailable') {
        // Fall back to our own camera rather than leaving someone unable to scan.
        setManual(true);
        setNotice({ text: 'Using the basic camera — you’ll need to crop by hand.' });
        return;
      }

      const collected: PendingPage[] = [];
      for (const uri of outcome.uris) {
        const bytes = await readPageBytes(uri);
        const size = await Image.getSize(uri).catch(() => ({ width: 0, height: 0 }));
        collected.push({
          bytes,
          ref: { id: uri, path: uri, width: size.width, height: size.height, bytes: bytes.length },
        });
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await commit(collected);
    } catch {
      setNotice({ text: 'That scan didn’t complete. Try again.' });
    } finally {
      setBusy(false);
    }
  }, [busy, commit]);

  const shoot = useCallback(
    async (keepGoing: boolean) => {
      if (camera.current === null || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const photo = await camera.current.takePictureAsync({ quality: 0.85 });
        if (photo === undefined) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        // Straighten and trim before anything else. A sideways page on a patterned
        // tablecloth is what turns a legible receipt into unsearchable noise.
        setEditing({
          page: { uri: photo.uri, width: photo.width, height: photo.height },
          keepGoing,
        });
      } catch {
        setNotice({ text: 'The camera didn’t manage that one. Try again.' });
      } finally {
        setBusy(false);
      }
    },
    [busy, pages, commit],
  );

  /** The edited page becomes the page we assemble and hash. */
  const accept = useCallback(
    async (edited: EditedPage, keepGoing: boolean) => {
      setEditing(null);
      setBusy(true);
      try {
        const bytes = await readPageBytes(edited.uri);
        const next: PendingPage = {
          bytes,
          ref: {
            id: edited.uri,
            path: edited.uri,
            width: edited.width,
            height: edited.height,
            bytes: bytes.length,
          },
        };
        const collected = [...pages, next];
        if (keepGoing) {
          setPages(collected);
          setNotice({
            text: `${collected.length} ${collected.length === 1 ? 'page' : 'pages'} — tap Done when finished.`,
          });
        } else {
          await commit(collected);
        }
      } catch {
        setNotice({ text: 'That page couldn’t be read. Try again.' });
      } finally {
        setBusy(false);
      }
    },
    [pages, commit],
  );

  if (server === null) {
    return (
      <View
        style={[
          styles.gate,
          { backgroundColor: palette.background, paddingTop: insets.top + spacing.xxl },
        ]}
      >
        <Text style={[styles.gateTitle, { color: palette.text }]}>
          Your documents. Your server.
        </Text>
        <Text style={[styles.gateBody, { color: palette.textMuted }]}>
          Sheaf sends what you scan straight to your own server. There is no account, and no copy
          anywhere else.
        </Text>
        <Button
          label="Connect your server"
          palette={palette}
          onPress={() => router.push('/connect')}
        />
      </View>
    );
  }

  if (manual && permission === null) {
    return <View style={{ flex: 1, backgroundColor: palette.shutterChrome }} />;
  }

  if (manual && permission !== null && !permission.granted) {
    return (
      <View
        style={[
          styles.gate,
          { backgroundColor: palette.background, paddingTop: insets.top + spacing.xxl },
        ]}
      >
        <Text style={[styles.gateTitle, { color: palette.text }]}>Sheaf needs the camera.</Text>
        <Text style={[styles.gateBody, { color: palette.textMuted }]}>
          It is used only to scan documents, and the images go to your own server and nowhere else.
        </Text>
        <Button label="Allow camera" palette={palette} onPress={() => void requestPermission()} />
      </View>
    );
  }

  const collecting = manual && pages.length > 0;

  if (editing !== null) {
    return (
      <PageEditor
        page={editing.page}
        palette={palette}
        busy={busy}
        onCancel={() => setEditing(null)}
        onDone={(edited) => void accept(edited, editing.keepGoing)}
      />
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.shutterChrome }]}>
      {manual ? (
        <CameraView ref={camera} style={styles.camera} facing="back" flash={flash} />
      ) : (
        <View style={[styles.camera, styles.idle]}>
          <Text style={styles.idleTitle}>Ready to scan</Text>
          <Text style={styles.idleBody}>
            Tap the button. The scanner finds the page, straightens it, and lets you add more before
            you finish.
          </Text>
        </View>
      )}

      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        {manual ? (
          <Chrome
            label={flash === 'on' ? 'Flash on' : 'Flash off'}
            accessibilityLabel={flash === 'on' ? 'Turn flash off' : 'Turn flash on'}
            onPress={() => setFlash(flash === 'on' ? 'off' : 'on')}
            active={flash === 'on'}
          />
        ) : (
          <View style={styles.chromeSpacer} />
        )}
        {offline ? <Text style={styles.offline}>Offline</Text> : <View />}
        <View style={styles.chromeSpacer} />
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.md }]}>
        {notice === null ? null : notice.docId === undefined ? (
          <Text style={styles.notice}>{notice.text}</Text>
        ) : (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={notice.text}
            onPress={() => {
              router.push(`/document/${notice.docId}`);
            }}
          >
            <Text style={[styles.notice, styles.noticeLink]}>{notice.text}</Text>
          </Pressable>
        )}

        {collecting ? (
          <>
            {/*
              The pages collected so far, so a multi-page scan is not done blind.
              Each can be dropped before the document is assembled -- afterwards the
              hash is fixed and the pages are the document.
            */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tray}
            >
              {pages.map((page, index) => (
                <View key={page.ref.id} style={styles.trayItem}>
                  <Image
                    source={{ uri: page.ref.path }}
                    style={styles.trayThumb}
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                  />
                  <Text style={styles.trayIndex}>{index + 1}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove page ${index + 1}`}
                    onPress={() => setPages(pages.filter((_, i) => i !== index))}
                    style={styles.trayRemove}
                  >
                    <Text style={styles.trayRemoveText}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>

            <View style={styles.pageRow}>
              <Chrome
                label={`Add page ${pages.length + 1}`}
                accessibilityLabel="Scan another page of this document"
                onPress={() => void shoot(true)}
              />
              <Chrome
                label={`Done · ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`}
                accessibilityLabel={`Finish document with ${pages.length} pages`}
                onPress={() => void commit(pages)}
                active
              />
            </View>
          </>
        ) : null}

        {/*
          Always present, always obviously tappable. The shutter stays the largest
          thing on screen, but it is no longer the only thing you can touch.
        */}
        <View style={styles.bar}>
          <Link href="/outbox" asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                waiting === 0 ? 'Outbox, everything synced' : `Outbox, ${waiting} waiting to sync`
              }
              style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
            >
              <Text style={styles.barLabel}>Outbox</Text>
              <Text style={styles.barMeta}>
                {waiting === 0 ? 'all synced' : `${waiting} waiting`}
              </Text>
            </Pressable>
          </Link>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={collecting ? 'Scan another page' : 'Scan document'}
            onPress={() => void (manual ? shoot(collecting) : scan())}
            disabled={busy}
            style={({ pressed }) => [styles.shutter, { opacity: busy ? 0.5 : pressed ? 0.8 : 1 }]}
          />

          <Link href="/settings" asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
            >
              <Text style={styles.barLabel}>Settings</Text>
              <Text style={styles.barMeta} numberOfLines={1}>
                {server.baseUrl.replace(/^https?:\/\//, '')}
              </Text>
            </Pressable>
          </Link>
        </View>
      </View>
    </View>
  );
}

/** A control that reads as a control against an unpredictable camera scene. */
function Chrome({
  label,
  accessibilityLabel,
  onPress,
  active = false,
}: {
  label: string;
  accessibilityLabel: string;
  onPress?: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chrome,
        active && styles.chromeActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.chromeText, active && styles.chromeTextActive]}>{label}</Text>
    </Pressable>
  );
}

const SCRIM = 'rgba(0,0,0,0.55)';

const styles = StyleSheet.create({
  root: { flex: 1 },
  idle: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  idleTitle: { color: '#ffffff', fontSize: 22, fontWeight: '600', marginBottom: spacing.sm },
  idleBody: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  camera: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  gate: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  gateTitle: { fontSize: 26, fontWeight: '600' },
  gateBody: { fontSize: 16, lineHeight: 24, marginBottom: spacing.md },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  chrome: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: SCRIM,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  chromeActive: { backgroundColor: '#ffffff' },
  chromeText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  chromeTextActive: { color: '#111110' },
  chromeSpacer: { width: 96 },
  offline: { color: '#f0d7a0', fontSize: 14, fontWeight: '700' },

  bottom: { marginTop: 'auto', gap: spacing.md, paddingHorizontal: spacing.md },
  notice: {
    color: '#ffffff',
    fontSize: 15,
    textAlign: 'center',
    backgroundColor: SCRIM,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    overflow: 'hidden',
  },
  noticeLink: { textDecorationLine: 'underline' },
  pageRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  tray: { gap: spacing.sm, paddingHorizontal: spacing.xs },
  trayItem: { width: 54, height: 72 },
  trayThumb: { width: 54, height: 72, borderRadius: 4, backgroundColor: SCRIM },
  trayIndex: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 5,
    borderRadius: 6,
    overflow: 'hidden',
  },
  trayRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trayRemoveText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },

  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  barButton: {
    minWidth: 104,
    minHeight: TOUCH_TARGET + 8,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: SCRIM,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  barLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  barMeta: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 1 },
  pressed: { opacity: 0.7 },

  shutter: {
    width: 78,
    height: 78,
    borderRadius: radius.pill,
    backgroundColor: '#ffffff',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.45)',
  },
});
