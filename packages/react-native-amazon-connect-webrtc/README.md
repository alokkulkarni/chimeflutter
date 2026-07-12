# react-native-amazon-connect-webrtc

Place **VoIP audio / WebRTC video calls into Amazon Connect** from a React Native app, using the
**native Amazon Chime SDKs** (Swift / Kotlin) with **CallKit** (iOS) and **Telecom** (Android)
integration so the OS treats the call like a real phone call — lock-screen controls, correct audio
routing, "like WhatsApp".

This is the React Native sibling of the `flutter_amazon_connect_webrtc` Flutter plugin in the same
repository: **same backend, same native media managers, same API contract, same behaviour.**

```tsx
import { ConnectWebRtcController, ConnectVideoView } from 'react-native-amazon-connect-webrtc';

const controller = new ConnectWebRtcController(
  { backendBaseUrl: 'https://YOUR_API_ID.execute-api.eu-west-2.amazonaws.com/v1', callKitEnabled: true },
  async () => '',   // tokenProvider — return your session JWT ('' = no Authorization header)
);

await controller.startCall({
  callType: 'audio',
  context: { issueType: 'billing', tier: 'gold' },   // drives Connect queue routing
  device: { platform: 'iOS', osVersion: '17.5', appVersion: '1.0.0',
            deviceModel: 'iPhone15,2', locale: 'en-GB', networkType: 'wifi' },
});

controller.onStateChanged((s) => console.log('call state:', s));
await controller.setMuted(true);
await controller.sendDtmf('1');   // IVR "press 1" — via the Connect Participant Service
await controller.endCall();
```

## Highlights

- **Audio + video calls** into Amazon Connect via `StartWebRTCContact` (through your backend — the
  app holds no AWS credentials).
- **System call UI**: CallKit / Jetpack Telecom (`CallsManager`), including the audio-session
  ordering rules AWS requires (media starts in `didActivate` / `onSetActive`).
- **Video tiles** rendered natively (`<ConnectVideoView tileId={…} />` — pixels never cross the JS
  bridge).
- **DTMF keypad support** for IVR menus (Participant Service, not in-band audio).
- **Prebuilt call UI** — `<ConnectCallScreen/>` (chooser or auto-dial via `enabledCallTypes`,
  controls, DTMF keypad, video tiles) so you don't have to build a screen to get started.
- **Works in a pure RN app AND in existing native apps** (brownfield): `registerConnectCallApp()`
  registers a self-contained call mini-app your Swift/Kotlin host mounts with `initialProperties`,
  observing call state natively (`Notification.Name.connectWebrtcEvent` /
  `ConnectWebrtcHostEvents.listener`) — the RN counterpart of the repo's Flutter add-to-app hosts.
- **Zero runtime npm dependencies** — `npm audit --omit=dev`: 0 by construction. TypeScript strict.
- **HTTPS enforced** for the backend URL; bearer tokens never logged; DTMF validated client-side.

## Documentation

| Doc | For |
|-----|-----|
| [Getting started](../../docs/react-native/GETTING_STARTED.md) | First integration, step by step, novice-friendly |
| [Integration guide](../../docs/react-native/INTEGRATION.md) | Concepts, full API reference, security posture |
| [Publishing guide](../../docs/react-native/PUBLISHING.md) | Shipping this package to npm / a private registry |

## Requirements

- React Native **>= 0.71** · iOS **15.0+** · Android **minSdk 26** (compileSdk 35+)
- The deployed backend from this repository (`backend/` — AWS SAM) and an Amazon Connect instance
  with in-app calling enabled.

## Tests

```bash
npm ci && npm run typecheck && npm test && npm audit
```
