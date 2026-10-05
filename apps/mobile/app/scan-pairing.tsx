import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { parsePairingUri } from '@sheaf/protocol';
import { useApp } from '../src/runtime/app-context';
import { spacing } from '../src/theme';
import { Button } from '../src/ui/components';

/**
 * Scans the pairing QR code your server shows, and hands what it read to the pairing
 * screen. Anything that is not a Sheaf pairing link is ignored, so a stray QR code in
 * view does nothing.
 */
export default function ScanPairing() {
  const { palette } = useApp();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  if (permission === null) return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  if (!permission.granted) {
    return (
      <View style={[styles.centre, { backgroundColor: palette.background }]}>
        <Text style={[styles.body, { color: palette.text }]}>
          Sheaf needs the camera to read the pairing code on your server’s screen.
        </Text>
        <Button label="Allow camera" palette={palette} onPress={() => void requestPermission()} />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          const pairing = parsePairingUri(data);
          if (pairing === null) return;
          handled.current = true;
          router.replace({ pathname: '/pair', params: pairing });
        }}
      />
      <Text style={styles.hint}>Point at the code under “Pair a phone” on your server.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  body: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  hint: {
    position: 'absolute',
    bottom: spacing.xxl,
    left: spacing.lg,
    right: spacing.lg,
    color: '#fff',
    fontSize: 15,
    textAlign: 'center',
  },
});
