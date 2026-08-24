import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link, useRouter } from 'expo-router';
import { assemble } from '@sheaf/pdf';
import type { PageRef } from '@sheaf/core';
import { pendingCount } from '@sheaf/store';
import { useApp } from '../src/runtime/app-context';
import { readPageBytes, writePdf } from '../src/adapters/files';
import { radius, spacing, TOUCH_TARGET } from '../src/theme';
import { Button } from '../src/ui/components';

interface PendingPage {
  readonly ref: PageRef;
  readonly bytes: Uint8Array;
}

/**
 * The shutter. The app opens here, with nothing in front of the camera.
 *
 * A tap commits the document and hands it to the sync loop immediately — there is
 * no review step to pass, because the point of the product is that capture never
 * waits for a human. Details are filed later, from whatever the server can tell us.
 */
export default function Shutter() {
  const { palette, outbox, offline, service, settings, server, refresh } = useApp();
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const camera = useRef<CameraView>(null);
  const router = useRouter();

  const [pages, setPages] = useState<readonly PendingPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [notice, setNotice] = useState<string | null>(null);

  const waiting = pendingCount(outbox);
  const needsFiling = outbox.filter((row) => row.status === 'SYNCED' && row.remoteId !== null);

  const commit = useCallback(
    async (collected: readonly PendingPage[]) => {
      if (collected.length === 0 || service === null) return;
      const result = assemble(
        collected.map((page) => page.bytes),
        { dpi: settings.dpi },
      );
      if (!result.ok) {
        setNotice('That page couldn’t be read. Try again.');
        return;
      }
      // The bytes land on disk before the event does, so a log entry never
      // describes a document that is not there.
      const file = writePdf(result.sha256, result.bytes);
      const outcome = await service.sync.capture({
        docId: result.sha256,
        sha256: result.sha256,
        bytes: file.size ?? result.bytes.length,
        pages: collected.map((page) => page.ref),
      });
      setPages([]);

      if (outcome.kind === 'already-captured') {
        // Identical content is the same document, so this is duplicate detection
        // for free -- and saying "saved" here would be a lie.
        setNotice(
          outcome.state.status === 'SYNCED'
            ? 'You’ve scanned this one already — it’s on your server.'
            : 'You’ve scanned this one already — it’s still on its way.',
        );
        return;
      }

      setNotice(
        offline
          ? 'Saved on this device. It’ll sync when your server is reachable.'
          : 'Saved. On its way to your server.',
      );
      await service.tick();
      await refresh();
    },
    [service, settings.dpi, offline, refresh],
  );

  const shoot = useCallback(
    async (keepGoing: boolean) => {
      if (camera.current === null || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const photo = await camera.current.takePictureAsync({ quality: 0.85 });
        if (photo === undefined) return;
        const bytes = await readPageBytes(photo.uri);
        const next: PendingPage = {
          bytes,
          ref: {
            id: `${photo.uri}`,
            path: photo.uri,
            width: photo.width,
            height: photo.height,
            bytes: bytes.length,
          },
        };
        const collected = [...pages, next];
        if (keepGoing) {
          setPages(collected);
          setNotice(
            `${collected.length} ${collected.length === 1 ? 'page' : 'pages'} — tap Done when finished.`,
          );
        } else {
          await commit(collected);
        }
      } catch {
        setNotice('The camera didn’t manage that one. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [busy, pages, commit],
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

  if (permission === null)
    return <View style={{ flex: 1, backgroundColor: palette.shutterChrome }} />;

  if (!permission.granted) {
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

  return (
    <View style={[styles.root, { backgroundColor: palette.shutterChrome }]}>
      <CameraView ref={camera} style={styles.camera} facing="back" flash={flash} />

      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={flash === 'on' ? 'Turn flash off' : 'Turn flash on'}
          onPress={() => setFlash(flash === 'on' ? 'off' : 'on')}
          style={styles.chromeButton}
        >
          <Text style={styles.chromeText}>{flash === 'on' ? 'Flash on' : 'Flash off'}</Text>
        </Pressable>
        {offline ? <Text style={styles.offline}>Offline</Text> : null}
        <Link href="/settings" asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            style={styles.chromeButton}
          >
            <Text style={styles.chromeText}>Settings</Text>
          </Pressable>
        </Link>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.lg }]}>
        {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}

        <View style={styles.shutterRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan another page of this document"
            onPress={() => void shoot(true)}
            disabled={busy}
            style={styles.sideButton}
          >
            <Text style={styles.sideLabel}>
              {pages.length > 0 ? `+ Page ${pages.length + 1}` : '+ Multi-page'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan document"
            onPress={() => void shoot(false)}
            disabled={busy}
            style={({ pressed }) => [styles.shutter, { opacity: busy ? 0.5 : pressed ? 0.8 : 1 }]}
          />

          {pages.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Finish document with ${pages.length} pages`}
              onPress={() => void commit(pages)}
              style={styles.sideButton}
            >
              <Text style={styles.sideLabel}>Done</Text>
            </Pressable>
          ) : (
            <View style={styles.sideButton} />
          )}
        </View>

        <View style={styles.statusRow}>
          <Link href="/outbox" asChild>
            <Pressable accessibilityRole="button" style={styles.statusLink}>
              <Text style={styles.statusText}>
                {waiting === 0
                  ? 'Everything is synced'
                  : `${waiting} ${waiting === 1 ? 'document' : 'documents'} waiting to sync`}
              </Text>
            </Pressable>
          </Link>
          {needsFiling.length > 0 ? (
            <Link href="/inbox" asChild>
              <Pressable accessibilityRole="button" style={styles.statusLink}>
                <Text style={styles.statusText}>{needsFiling.length} to file</Text>
              </Pressable>
            </Link>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  gate: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  gateTitle: { fontSize: 26, fontWeight: '600' },
  gateBody: { fontSize: 16, lineHeight: 24, marginBottom: spacing.md },
  camera: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  chromeButton: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  chromeText: { color: '#ffffff', fontSize: 15, fontWeight: '500' },
  offline: { color: '#f0d7a0', fontSize: 14, fontWeight: '600' },
  bottom: { marginTop: 'auto', gap: spacing.md, paddingHorizontal: spacing.md },
  notice: { color: '#ffffff', fontSize: 15, textAlign: 'center' },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideButton: { width: 96, minHeight: TOUCH_TARGET, justifyContent: 'center' },
  sideLabel: { color: '#ffffff', fontSize: 15, fontWeight: '500', textAlign: 'center' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: radius.pill,
    backgroundColor: '#ffffff',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  statusRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.lg },
  statusLink: { minHeight: TOUCH_TARGET, justifyContent: 'center' },
  statusText: { color: 'rgba(255,255,255,0.85)', fontSize: 14 },
});
