import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { parseEnabledCallTypes, soleCallType } from './callTypes';
import { ConnectVideoView } from './ConnectVideoView';
import type { ConnectWebRtcController } from './ConnectWebRtcController';
import type { CallState, CallType, DeviceInfo } from './types';

export interface ConnectCallScreenProps {
  controller: ConnectWebRtcController;
  /** `"audio,video"` (default — chooser shown) · `"audio"` · `"video"` (chooser skipped; that type
   *  dials immediately when the screen mounts). Parity with the Flutter module's config. */
  enabledCallTypes?: string;
  /** Routing context → Connect contact attributes (allow-listed server-side). */
  context?: Record<string, string>;
  /** Overrides for the device payload; sensible platform defaults are filled in. */
  device?: Partial<DeviceInfo>;
  /** Header title. */
  displayName?: string;
}

function defaultDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: Platform.OS === 'ios' ? 'iOS' : 'Android',
    osVersion: String(Platform.Version),
    appVersion: '0.0.0',
    deviceModel: 'unknown',
    locale: 'en',
    networkType: 'unknown',
    ...overrides,
  };
}

const KEYPAD: Array<Array<[string, string]>> = [
  [['1', ' '], ['2', 'ABC'], ['3', 'DEF']],
  [['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO']],
  [['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ']],
  [['*', ' '], ['0', '+'], ['#', ' ']],
];

/** Screen-reader name for a keypad key: digits read with their letters, symbols by name. */
export function keypadKeyLabel(digit: string, letters?: string): string {
  if (digit === '*') return 'Star';
  if (digit === '#') return 'Pound';
  const trimmed = letters?.trim();
  return trimmed ? `${digit}, ${trimmed}` : digit;
}

/** What screen readers announce when the call state changes. */
export function stateAnnouncement(state: CallState): string {
  switch (state) {
    case 'idle':
      return 'Ready to call';
    case 'connecting':
      return 'Connecting call';
    case 'ringing':
      return 'Ringing';
    case 'connected':
      return 'Call connected';
    case 'reconnecting':
      return 'Reconnecting call';
    case 'disconnected':
      return 'Call ended';
    case 'failed':
      return 'Call failed';
  }
}

/**
 * Ready-made WhatsApp-style call screen — the React Native counterpart of the Flutter module's
 * `CallHome`. Handles the audio/video chooser (or auto-dial when a single call type is enabled),
 * in-call controls (mute / speaker / video / camera-flip), a DTMF keypad for IVR menus, and the
 * remote + local (picture-in-picture) video tiles. Pure react-native primitives — no extra deps.
 *
 * Accessibility: every touchable exposes a role, name and state to VoiceOver/TalkBack; call-state
 * changes and DTMF sends are announced (live regions + announceForAccessibility); decorative
 * glyphs are hidden from assistive tech; text meets WCAG 4.5:1 contrast; touch targets are
 * ≥ 48dp. Guarded by the accessibility test suite.
 */
export function ConnectCallScreen({
  controller,
  enabledCallTypes,
  context,
  device,
  displayName = 'Support',
}: ConnectCallScreenProps) {
  const types = parseEnabledCallTypes(enabledCallTypes);
  const sole = soleCallType(types);
  const videoEnabled = types.has('video');

  const [state, setState] = useState<CallState>(controller.getState());
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [remoteTile, setRemoteTile] = useState<number | null>(null);
  const [localTile, setLocalTile] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [keypadVisible, setKeypadVisible] = useState(false);
  const [dialed, setDialed] = useState('');
  const autoDialed = useRef(false);

  const start = useCallback(
    async (callType: CallType) => {
      setError(null);
      try {
        await controller.startCall({
          callType,
          context,
          device: defaultDevice(device),
        });
        if (callType === 'video') {
          await controller.enableLocalVideo();
          setVideoOn(true);
        }
      } catch (e) {
        const err = e as { code?: string; message?: string };
        setError(`${err.code ?? 'error'}: ${err.message ?? String(e)}`);
      }
    },
    [controller, context, device],
  );

  useEffect(() => {
    const offState = controller.onStateChanged((next) => {
      setState(next);
      // Screen readers hear every call-state transition without focusing the status text.
      AccessibilityInfo.announceForAccessibility(stateAnnouncement(next));
    });
    const offEvent = controller.onEvent((e) => {
      if (e.type === 'remoteVideoAvailable') setRemoteTile(e.tileId);
      if (e.type === 'localVideoAvailable') setLocalTile(e.tileId);
      if (e.type === 'videoTileRemoved') {
        setRemoteTile((t) => (t === e.tileId ? null : t));
        setLocalTile((t) => (t === e.tileId ? null : t));
      }
      if (e.type === 'muteChanged') setMuted(e.muted);
      if (e.type === 'error') setError(`${e.code}: ${e.message}`);
    });
    return () => {
      offState();
      offEvent();
    };
  }, [controller]);

  // Single-call-type mode: skip the chooser and dial immediately on first mount. Never re-dial
  // after a hang-up (the idle screen then shows a single redial button instead).
  useEffect(() => {
    if (sole && !autoDialed.current && !controller.isInCall) {
      autoDialed.current = true;
      void start(sole);
    }
  }, [sole, controller, start]);

  // Call duration ticker + reset of per-call UI state on terminal states.
  useEffect(() => {
    if (state === 'connected') {
      const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
      return () => clearInterval(timer);
    }
    if (state === 'disconnected' || state === 'failed') {
      setElapsed(0);
      setMuted(false);
      setSpeakerOn(false);
      setVideoOn(false);
      setKeypadVisible(false);
      setDialed('');
    }
    return undefined;
  }, [state]);

  const active =
    state === 'connecting' || state === 'ringing' || state === 'connected' || state === 'reconnecting';

  const status = (): string => {
    switch (state) {
      case 'idle':
        return 'Ready when you are';
      case 'connecting':
        return 'Connecting…';
      case 'ringing':
        return 'Ringing…';
      case 'connected': {
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }
      case 'reconnecting':
        return 'Reconnecting…';
      case 'disconnected':
        return 'Call ended';
      case 'failed':
        return 'Call failed';
    }
  };

  const sendDigit = async (digit: string) => {
    setDialed((d) => d + digit);
    try {
      await controller.sendDtmf(digit);
    } catch {
      setDialed('send failed');
    }
  };

  return (
    <View style={styles.root}>
      {remoteTile != null && (
        <ConnectVideoView
          tileId={remoteTile}
          accessibilityLabel="Agent video"
          style={StyleSheet.absoluteFill}
        />
      )}
      {localTile != null && (
        <ConnectVideoView
          tileId={localTile}
          mirror
          accessibilityLabel="Your camera preview"
          style={styles.localPreview}
        />
      )}

      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {displayName}
        </Text>
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status()}
        </Text>
      </View>

      {remoteTile == null && (
        // Decorative — the header already conveys who the call is with and its state.
        <View style={styles.avatarWrap} importantForAccessibility="no-hide-descendants" accessible={false}>
          <View style={[styles.avatar, (state === 'connecting' || state === 'ringing') && styles.avatarPulsing]}>
            <Text style={styles.avatarGlyph}>🎧</Text>
          </View>
        </View>
      )}

      <View style={styles.footer}>
        {error != null && (
          <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        )}

        {!active ? (
          sole ? (
            <RoundedButton
              label={sole === 'video' ? 'Video call' : 'Audio call'}
              color={sole === 'video' ? '#5c6bc0' : '#2e7d32'}
              onPress={() => start(sole)}
            />
          ) : (
            <View style={styles.row}>
              <RoundedButton label="Audio call" color="#2e7d32" onPress={() => start('audio')} flex />
              <View style={styles.gap} />
              <RoundedButton label="Video call" color="#5c6bc0" onPress={() => start('video')} flex />
            </View>
          )
        ) : (
          <>
            <View style={styles.controlsRow}>
              <ControlButton
                label="Mute"
                accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
                glyph={muted ? '🔇' : '🎙'}
                active={muted}
                onPress={() => controller.setMuted(!muted)}
              />
              <ControlButton
                label="Speaker"
                accessibilityLabel={speakerOn ? 'Turn speaker off' : 'Turn speaker on'}
                glyph="🔊"
                active={speakerOn}
                onPress={async () => {
                  await controller.setSpeakerphone(!speakerOn);
                  setSpeakerOn(!speakerOn);
                }}
              />
              {videoEnabled && (
                <ControlButton
                  label="Video"
                  accessibilityLabel={videoOn ? 'Turn camera off' : 'Turn camera on'}
                  glyph={videoOn ? '📹' : '🚫'}
                  active={videoOn}
                  onPress={async () => {
                    await (videoOn ? controller.disableLocalVideo() : controller.enableLocalVideo());
                    setVideoOn(!videoOn);
                  }}
                />
              )}
              <ControlButton
                label="Keypad"
                accessibilityLabel="Open keypad"
                glyph="🔢"
                onPress={() => setKeypadVisible(true)}
              />
              {videoEnabled && (
                <ControlButton
                  label="Flip"
                  accessibilityLabel="Switch camera"
                  glyph="🔄"
                  disabled={!videoOn}
                  onPress={() => controller.switchCamera()}
                />
              )}
            </View>
            <Pressable
              style={styles.hangup}
              accessibilityRole="button"
              accessibilityLabel="End call"
              onPress={() => controller.endCall()}
            >
              <Text style={styles.hangupGlyph} accessible={false} importantForAccessibility="no">
                📞
              </Text>
            </Pressable>
          </>
        )}
      </View>

      <Modal visible={keypadVisible} transparent animationType="slide" onRequestClose={() => setKeypadVisible(false)}>
        <Pressable
          style={styles.sheetBackdrop}
          accessibilityRole="button"
          accessibilityLabel="Close keypad"
          onPress={() => setKeypadVisible(false)}
        >
          {/* Structural tap-catcher (stops backdrop dismissal) — not a control, hidden from AT. */}
          <Pressable
            style={styles.sheet}
            accessibilityViewIsModal
            accessible={false}
            importantForAccessibility="no"
            onPress={() => undefined}
          >
            <Text
              style={styles.dialed}
              accessibilityLiveRegion="polite"
              accessibilityLabel={dialed.length === 0 ? 'No digits entered yet' : `Sent: ${dialed}`}
            >
              {dialed.length === 0 ? 'Enter digits' : dialed}
            </Text>
            {KEYPAD.map((row, i) => (
              <View key={i} style={styles.keypadRow}>
                {row.map(([digit, letters]) => (
                  <Pressable
                    key={digit}
                    style={styles.key}
                    accessibilityRole="button"
                    accessibilityLabel={keypadKeyLabel(digit, letters)}
                    onPress={() => sendDigit(digit)}
                  >
                    <Text style={styles.keyDigit} accessible={false} importantForAccessibility="no">
                      {digit}
                    </Text>
                    <Text style={styles.keyLetters} accessible={false} importantForAccessibility="no">
                      {letters}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function RoundedButton({
  label,
  color,
  onPress,
  flex,
}: {
  label: string;
  color: string;
  onPress: () => void;
  flex?: boolean;
}) {
  return (
    <Pressable
      style={[styles.cta, { backgroundColor: color }, flex && styles.flex1]}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
    >
      <Text style={styles.ctaLabel}>{label}</Text>
    </Pressable>
  );
}

function ControlButton({
  label,
  accessibilityLabel,
  glyph,
  active,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  glyph: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.control}>
      <Pressable
        style={[styles.controlCircle, active && styles.controlActive, disabled && styles.controlDisabled]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ selected: active === true, disabled: disabled === true }}
        disabled={disabled}
        onPress={onPress}
      >
        <Text style={styles.controlGlyph} accessible={false} importantForAccessibility="no">
          {glyph}
        </Text>
      </Pressable>
      <Text style={styles.controlLabel} accessible={false} importantForAccessibility="no">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#14162e' },
  header: { alignItems: 'center', marginTop: 64 },
  title: { color: 'white', fontSize: 26, fontWeight: '600' },
  status: { color: '#ffffffcc', fontSize: 15, marginTop: 6 },
  avatarWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatar: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: '#2a2c4e',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffffff22',
  },
  avatarPulsing: { borderWidth: 3, borderColor: '#7986cb' },
  avatarGlyph: { fontSize: 56 },
  footer: { paddingHorizontal: 24, paddingBottom: 48 },
  error: { color: '#ef5350', textAlign: 'center', marginBottom: 12 },
  row: { flexDirection: 'row' },
  gap: { width: 14 },
  flex1: { flex: 1 },
  cta: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  ctaLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
  controlsRow: { flexDirection: 'row', justifyContent: 'space-evenly', marginBottom: 28 },
  control: { alignItems: 'center' },
  controlCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#ffffff1f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlActive: { backgroundColor: 'white' },
  controlDisabled: { opacity: 0.35 },
  controlGlyph: { fontSize: 24 },
  controlLabel: { color: '#ffffffcc', fontSize: 12, marginTop: 6 },
  hangup: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#e53935',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hangupGlyph: { fontSize: 30, transform: [{ rotate: '135deg' }] },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000066' },
  sheet: {
    backgroundColor: '#1a1b33',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
  },
  dialed: { color: 'white', fontSize: 26, letterSpacing: 4, textAlign: 'center', marginBottom: 8 },
  keypadRow: { flexDirection: 'row' },
  key: { flex: 1, alignItems: 'center', paddingVertical: 12, minHeight: 48, justifyContent: 'center' },
  keyDigit: { color: 'white', fontSize: 30 },
  keyLetters: { color: '#ffffff99', fontSize: 10 },
  localPreview: {
    position: 'absolute',
    top: 56,
    right: 16,
    width: 104,
    height: 156,
    borderRadius: 12,
    overflow: 'hidden',
    zIndex: 2,
  },
});
