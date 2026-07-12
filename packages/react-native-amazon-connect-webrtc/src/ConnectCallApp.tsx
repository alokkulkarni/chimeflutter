import React, { useEffect, useMemo } from 'react';
import { AppRegistry } from 'react-native';

import { ConnectCallScreen } from './ConnectCallScreen';
import { ConnectWebRtcController } from './ConnectWebRtcController';
import type { DeviceInfo } from './types';

/**
 * Initial properties the NATIVE HOST passes when mounting the call screen
 * (`RCTRootView(initialProperties:)` on iOS / `launchOptions` Bundle on Android).
 * The React Native counterpart of the Flutter host bridge's `getConfig`/`getCustomerContext`.
 */
export interface ConnectCallAppProps {
  /** The `ApiBaseUrl` output of `sam deploy` (https:// enforced). */
  backendBaseUrl: string;
  /** `"audio,video"` (default — chooser) · `"audio"` · `"video"` (auto-dial, chooser skipped). */
  enabledCallTypes?: string;
  /** Bearer token for the backend ('' / omitted = no Authorization header). The host owns auth —
   *  pass a fresh token each time it presents the call screen. */
  authToken?: string;
  /** Routing context → Connect contact attributes (allow-listed server-side). */
  context?: Record<string, string>;
  /** Name shown in the header and the system call UI. */
  callDisplayName?: string;
  /** Device payload overrides (appVersion, deviceModel, locale, networkType). */
  device?: Partial<DeviceInfo>;
}

/**
 * Self-contained call mini-app for brownfield embedding — the React Native counterpart of
 * `flutter_call_module`. A native iOS/Android app mounts it in an `RCTRootView` /
 * `ReactRootView` (keeping ONE React instance alive app-wide, like Flutter's cached engine, so
 * the call survives the screen being dismissed) and observes call events natively via
 * `Notification.Name.connectWebrtcEvent` (iOS) / `ConnectWebrtcHostEvents.listener` (Android).
 */
export function ConnectCallApp({
  backendBaseUrl,
  enabledCallTypes,
  authToken,
  context,
  callDisplayName = 'Support',
  device,
}: ConnectCallAppProps) {
  const controller = useMemo(
    () =>
      new ConnectWebRtcController(
        { backendBaseUrl, callKitEnabled: true, callDisplayName },
        () => authToken ?? '',
      ),
    [backendBaseUrl, callDisplayName, authToken],
  );

  useEffect(() => () => controller.dispose(), [controller]);

  return (
    <ConnectCallScreen
      controller={controller}
      enabledCallTypes={enabledCallTypes}
      context={context}
      device={device}
      displayName={callDisplayName}
    />
  );
}

/**
 * Registers [ConnectCallApp] with the AppRegistry so native hosts can mount it by name.
 * Call this from your JS entry file (index.js):
 *
 * ```js
 * import { registerConnectCallApp } from 'react-native-amazon-connect-webrtc';
 * registerConnectCallApp();          // registers 'ConnectCallApp'
 * ```
 */
export function registerConnectCallApp(appKey = 'ConnectCallApp'): string {
  AppRegistry.registerComponent(appKey, () => ConnectCallApp);
  return appKey;
}
