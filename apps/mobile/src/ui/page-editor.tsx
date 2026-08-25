import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  clamp,
  fullSelection,
  isMeaningfulCrop,
  rotatedSize,
  toImageRect,
  turn,
  type Rect,
  type Rotation,
  type Size,
} from '../lib/crop';
import { radius, spacing, TOUCH_TARGET } from '../theme';

export interface EditedPage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Straighten and trim a page before it becomes a document.
 *
 * This is not the metadata review step that ADR 0003 removed — nothing here asks
 * who the document is from or what to call it. It is part of scanning, and the
 * measurements say so: the same receipt went from 56 characters of OCR noise to
 * 257 of readable text purely by being turned upright and trimmed away from the
 * tablecloth it was lying on. A capture app that skips this is fast at producing
 * documents nobody can search.
 *
 * Deliberately only two operations. A hand-rolled contrast filter was tried and
 * measured *worse* (209 characters), because thresholding a crumpled receipt
 * destroys as many strokes as it sharpens.
 */
export function PageEditor({
  page,
  palette,
  onCancel,
  onDone,
  busy,
}: {
  page: EditedPage;
  palette: { text: string; accent: string; accentText: string };
  onCancel: () => void;
  onDone: (edited: EditedPage) => void;
  busy: boolean;
}) {
  const [rotation, setRotation] = useState<Rotation>(0);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [selection, setSelection] = useState<Rect | null>(null);
  const [working, setWorking] = useState(false);

  const image = useMemo<Size>(() => ({ width: page.width, height: page.height }), [page]);
  const start = useRef<Rect | null>(null);

  const resetSelection = useCallback(
    (next: Rotation, size: Size) => {
      if (size.width > 0) setSelection(fullSelection(size, image, next));
    },
    [image],
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainer({ width, height });
    resetSelection(rotation, { width, height });
  };

  const rotateBy = (direction: 1 | -1) => {
    const next = turn(rotation, direction);
    setRotation(next);
    // The visible shape changes, so any existing selection now means something
    // different. Starting fresh is less surprising than silently reinterpreting it.
    resetSelection(next, container);
  };

  /** Drag a corner. The opposite corner stays put, which is what people expect. */
  const corner = (corner: 'tl' | 'tr' | 'bl' | 'br') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start.current = selection;
      },
      onPanResponderMove: (_event, gesture) => {
        const from = start.current;
        if (from === null) return;
        const left = corner === 'tl' || corner === 'bl';
        const top = corner === 'tl' || corner === 'tr';
        const x = left ? from.x + gesture.dx : from.x;
        const y = top ? from.y + gesture.dy : from.y;
        const width = left ? from.width - gesture.dx : from.width + gesture.dx;
        const height = top ? from.height - gesture.dy : from.height + gesture.dy;
        // A minimum keeps the handles reachable after an over-enthusiastic drag.
        setSelection({
          x,
          y,
          width: Math.max(48, width),
          height: Math.max(48, height),
        });
      },
    });

  const handles = useMemo(
    () => ({ tl: corner('tl'), tr: corner('tr'), bl: corner('bl'), br: corner('br') }),
    // Recreated when the selection changes so each drag starts from the current rect.
    [selection],
  );

  const apply = async () => {
    if (working || busy) return;
    setWorking(true);
    try {
      const rotated = rotatedSize(image, rotation);
      const context = ImageManipulator.manipulate(page.uri);
      if (rotation !== 0) context.rotate(rotation);

      if (selection !== null && container.width > 0) {
        const rect = toImageRect(selection, container, image, rotation);
        // Skip a crop that is really the whole page: it would re-encode the image
        // for nothing, costing quality on the way to a file meant to be unchanged.
        if (isMeaningfulCrop(rect, rotated)) {
          // The manipulator names the corner originX/originY; our geometry calls it
          // x/y, so the translation happens once, here.
          const { x, y, width, height } = clamp(rect, rotated);
          context.crop({ originX: x, originY: y, width, height });
        }
      }

      const rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
      onDone({ uri: saved.uri, width: saved.width, height: saved.height });
    } catch {
      // Editing failing must not cost the capture, so fall back to the original.
      onDone(page);
    } finally {
      setWorking(false);
    }
  };

  const disabled = working || busy;

  return (
    <View style={styles.root}>
      <View style={styles.stage} onLayout={onLayout}>
        <Image
          source={{ uri: page.uri }}
          // The preview turns with the page, so the crop is drawn on what will be
          // saved rather than on the untouched original.
          style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${rotation}deg` }] }]}
          resizeMode="contain"
        />
        {selection === null ? null : (
          <>
            <View
              pointerEvents="none"
              style={[
                styles.selection,
                {
                  left: selection.x,
                  top: selection.y,
                  width: selection.width,
                  height: selection.height,
                },
              ]}
            />
            {(['tl', 'tr', 'bl', 'br'] as const).map((key) => {
              const left = key === 'tl' || key === 'bl';
              const top = key === 'tl' || key === 'tr';
              return (
                <View
                  key={key}
                  {...handles[key].panHandlers}
                  accessibilityRole="adjustable"
                  accessibilityLabel={`Crop handle, ${top ? 'top' : 'bottom'} ${left ? 'left' : 'right'}`}
                  style={[
                    styles.handle,
                    {
                      left: (left ? selection.x : selection.x + selection.width) - HANDLE / 2,
                      top: (top ? selection.y : selection.y + selection.height) - HANDLE / 2,
                    },
                  ]}
                >
                  <View style={styles.handleDot} />
                </View>
              );
            })}
          </>
        )}
      </View>

      <View style={styles.controls}>
        <Control label="Rotate ⟲" onPress={() => rotateBy(-1)} disabled={disabled} />
        <Control label="Rotate ⟳" onPress={() => rotateBy(1)} disabled={disabled} />
        <Control label="Retake" onPress={onCancel} disabled={disabled} />
        <Control
          label={working ? 'Working…' : 'Use page'}
          onPress={() => void apply()}
          disabled={disabled}
          primary
          palette={palette}
        />
      </View>
    </View>
  );
}

function Control({
  label,
  onPress,
  disabled,
  primary = false,
  palette,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  primary?: boolean;
  palette?: { accent: string; accentText: string };
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.control,
        primary && palette ? { backgroundColor: palette.accent } : null,
        { opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[styles.controlText, primary && palette ? { color: palette.accentText } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const HANDLE = 44;
const SCRIM = 'rgba(0,0,0,0.55)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  stage: { flex: 1, margin: spacing.sm },
  selection: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#ffffff',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.4)',
  },
  controls: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    justifyContent: 'center',
  },
  control: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: SCRIM,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  controlText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
