import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
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
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

  if (permission === null) {
    return <View style={{ flex: 1, backgroundColor: palette.shutterChrome }} />;
  }

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

  const collecting = pages.length > 0;

  return (
    <View style={[styles.root, { backgroundColor: palette.shutterChrome }]}>
      <CameraView ref={camera} style={styles.camera} facing="back" flash={flash} />

      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <Chrome
          label={flash === 'on' ? 'Flash on' : 'Flash off'}
          accessibilityLabel={flash === 'on' ? 'Turn flash off' : 'Turn flash on'}
          onPress={() => setFlash(flash === 'on' ? 'off' : 'on')}
          active={flash === 'on'}
        />
        {offline ? <Text style={styles.offline}>Offline</Text> : <View />}
        {needsFiling.length > 0 ? (
          <Link href="/inbox" asChild>
            <Chrome
              label={`${needsFiling.length} to file`}
              accessibilityLabel="Documents to file"
            />
          </Link>
        ) : (
          <View style={styles.chromeSpacer} />
        )}
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.md }]}>
        {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}

        {collecting ? (
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
            onPress={() => void shoot(collecting)}
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
  pageRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },

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
