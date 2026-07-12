/** Minimal react-native surface so the pure-TS core can be imported under Jest. Tests inject fake
 *  bridges/transports; nothing here is exercised beyond module resolution. */
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

export function requireNativeComponent<T>(_name: string): T {
  return ((..._args: unknown[]) => null) as unknown as T;
}

export type ViewProps = Record<string, unknown>;
