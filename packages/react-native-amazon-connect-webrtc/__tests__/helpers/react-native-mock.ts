/** Minimal react-native surface for Jest. Components render as plain host elements so
 *  react-test-renderer can traverse the tree (used by the accessibility test suite); the native
 *  module/emitter stubs satisfy module resolution for the pure-TS core tests. */
import React from 'react';

function host<P extends object>(name: string) {
  const Component = (props: P) => React.createElement(name, props as Record<string, unknown>);
  (Component as { displayName?: string }).displayName = name;
  return Component;
}

export const View = host('View');
export const Text = host('Text');
export const Pressable = host('Pressable');
export const Modal = host('Modal');

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  flatten: (style: unknown) => style,
};

export const AccessibilityInfo = {
  announceForAccessibility: jest.fn(),
};

export const NativeModules: Record<string, unknown> = {
  ConnectWebrtc: {
    addListener: () => undefined,
    removeListeners: () => undefined,
  },
};

export class NativeEventEmitter {
  addListener(_event: string, _listener: (payload: unknown) => void) {
    return { remove: () => undefined };
  }
}

export const Platform = { OS: 'ios', Version: '17.0' };

export const PermissionsAndroid = {
  PERMISSIONS: {
    RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
    CAMERA: 'android.permission.CAMERA',
    POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
  },
  requestMultiple: async () => ({}),
};

export function requireNativeComponent<T>(name: string): T {
  return host(name) as unknown as T;
}

export type ViewProps = Record<string, unknown>;
