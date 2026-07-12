import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import type { CallEvent, CallSession, CallType } from './types';

/** Everything the native module (iOS Swift / Android Kotlin) exposes. Injected into the
 *  controller so tests can substitute a fake. */
export interface NativeBridge {
  /** Verify (and prompt for) mic — and camera for video — permission. Resolves false if denied. */
  ensurePermissions(callType: CallType): Promise<boolean>;
  /** Build + start the native Chime media session (with CallKit/Telecom when enabled). */
  join(session: CallSession, callKitEnabled: boolean, callDisplayName: string): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<boolean>;
  setLocalVideoEnabled(enabled: boolean): Promise<void>;
  switchCamera(): Promise<void>;
  setSpeakerphoneEnabled(enabled: boolean): Promise<void>;
  /** Subscribe to native call events; returns the unsubscribe function. */
  addEventListener(listener: (event: CallEvent) => void): () => void;
}

interface ConnectWebrtcNativeModule {
  join(args: Record<string, unknown>): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<boolean>;
  setLocalVideoEnabled(enabled: boolean): Promise<void>;
  switchCamera(): Promise<void>;
  setSpeakerphoneEnabled(enabled: boolean): Promise<void>;
  /** iOS only — AVCaptureDevice/AVAudioSession prompts. On Android, PermissionsAndroid is used. */
  requestPermissions(needsCamera: boolean): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const EVENT_NAME = 'ConnectWebrtcEvent';

function requireModule(): ConnectWebrtcNativeModule {
  const module = NativeModules.ConnectWebrtc as ConnectWebrtcNativeModule | undefined;
  if (!module) {
    throw new Error(
      "react-native-amazon-connect-webrtc: native module 'ConnectWebrtc' not found. " +
        'Run pod install (iOS) / rebuild the app (Android) — see the getting-started guide.',
    );
  }
  return module;
}

async function ensureAndroidPermissions(callType: CallType): Promise<boolean> {
  // RN types PERMISSIONS through an index signature; these constants always exist at runtime.
  const RECORD_AUDIO = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO!;
  const CAMERA = PermissionsAndroid.PERMISSIONS.CAMERA!;
  const POST_NOTIFICATIONS = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS!;

  const wanted = [
    RECORD_AUDIO,
    ...(callType === 'video' ? [CAMERA] : []),
    // Needed on API 33+ for the ongoing-call notification; declared in the library manifest.
    ...(Number(Platform.Version) >= 33 ? [POST_NOTIFICATIONS] : []),
  ];
  const results = await PermissionsAndroid.requestMultiple(wanted);
  const micGranted = results[RECORD_AUDIO] === 'granted';
  const cameraGranted = callType !== 'video' || results[CAMERA] === 'granted';
  // POST_NOTIFICATIONS being denied degrades the notification, not the call — don't block on it.
  return micGranted && cameraGranted;
}

/** The production bridge over `NativeModules.ConnectWebrtc` + its event emitter. */
export function createNativeBridge(): NativeBridge {
  const module = requireModule();
  const emitter = new NativeEventEmitter(NativeModules.ConnectWebrtc);

  return {
    async ensurePermissions(callType) {
      if (Platform.OS === 'android') return ensureAndroidPermissions(callType);
      return module.requestPermissions(callType === 'video');
    },
    join(session, callKitEnabled, callDisplayName) {
      // The native side receives the CallSession fields plus the call options, exactly like the
      // Flutter method-channel contract (specs/003 §B.1).
      return module.join({
        ...session,
        callKitEnabled,
        callDisplayName,
      });
    },
    leave: () => module.leave(),
    setMuted: (muted) => module.setMuted(muted),
    setLocalVideoEnabled: (enabled) => module.setLocalVideoEnabled(enabled),
    switchCamera: () => module.switchCamera(),
    setSpeakerphoneEnabled: (enabled) => module.setSpeakerphoneEnabled(enabled),
    addEventListener(listener) {
      const subscription = emitter.addListener(EVENT_NAME, (event) =>
        listener(event as CallEvent),
      );
      return () => subscription.remove();
    },
  };
}
