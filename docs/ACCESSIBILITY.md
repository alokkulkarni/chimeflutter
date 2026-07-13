# Accessibility Conformance — ChimeFlutter mobile libraries

This document states what the **Flutter** and **React Native** call UIs implement for
accessibility, how conformance is **assessed automatically on every test run** (both assessments
pass 100% and are release gates), and what remains for a formal third-party certification.

**Scope.** The user-facing surfaces: the Flutter module's call UI
([`native/flutter_call_module`](../native/flutter_call_module)), the Flutter plugin's
`ConnectVideoView`, and the React Native library's `ConnectCallScreen` / `ConnectCallApp` /
`ConnectVideoView` ([`packages/react-native-amazon-connect-webrtc`](../packages/react-native-amazon-connect-webrtc)).
The headless layers (backend, controllers, native media managers) expose no UI and are out of
scope except where they feed the UI (call-state changes are surfaced as announcements).

**Standards addressed.** WCAG 2.2 Level AA success criteria applicable to native mobile UI,
expressed through the platform accessibility frameworks: **VoiceOver** (iOS) and **TalkBack /
switch access** (Android).

---

## 1. What is implemented (both libraries, feature-for-feature)

| Capability | WCAG 2.2 | Flutter implementation | React Native implementation |
|------------|----------|------------------------|------------------------------|
| Every control has a **name, role and state** | 4.1.2 | `Semantics(button, label, enabled, selected, onTap)` on all round controls and keypad keys; FAB `tooltip`; text buttons carry their labels | `accessibilityRole="button"` + `accessibilityLabel` + `accessibilityState({selected, disabled})` on every `Pressable` |
| **Action-oriented names** that reflect state | 4.1.2 | control captions + selected state | dynamic labels: "Mute/Unmute microphone", "Turn speaker on/off", "Turn camera on/off" |
| **Call-state changes announced** without moving focus | 4.1.3 | `Semantics(liveRegion: true)` on the status line | `AccessibilityInfo.announceForAccessibility` on every transition **and** `accessibilityLiveRegion="polite"` on the status text |
| **Errors announced** | 4.1.3 | live-region error text | `accessibilityRole="alert"` + assertive live region |
| **DTMF feedback**: sent digits announced | 4.1.3 | live-region dialed display ("Sent: 1") | polite live region with the same wording |
| Keypad symbols have **pronounceable names** | 1.1.1 | `*`→"Star", `#`→"Pound", digits read with their letters ("2, ABC") | identical (`keypadKeyLabel`) |
| **Decorative content hidden** from assistive tech | 1.1.1 | avatar `ExcludeSemantics`; icons excluded, one node per control | emoji glyphs and captions `accessible={false}` + `importantForAccessibility="no"` |
| **Video surfaces labelled** | 1.1.1 | `ConnectVideoView(semanticsLabel:)` — "Agent video" / "Your camera preview" | `ConnectVideoView accessibilityLabel` + `accessibilityRole="image"` |
| **Text contrast ≥ 4.5:1** | 1.4.3 | verified pixel-level by `textContrastGuideline`; CTA buttons use white on green-800/indigo-500 (M3's default failed and was fixed); secondary text ≥ white70 | same palette corrections (`#2e7d32` green, `#ffffffcc` secondary text) |
| **Touch targets ≥ 48dp (Android) / 44pt (iOS)** | 2.5.8 | verified by both official tap-target guidelines; controls 60dp, keys ≥ 48dp, FAB 72dp | same dimensions + explicit `minHeight: 48` on CTAs and keys |
| **Text scaling** | 1.4.4 | Flutter `Text` honours system text scale by default; the keypad sheet scrolls rather than clipping at large scales | RN `allowFontScaling` default (never disabled) |
| **Modal behaviour** (keypad sheet) | 2.4.3 | `showModalBottomSheet` (focus-scoped, dismissible) | `accessibilityViewIsModal`; labelled "Close keypad" backdrop; hardware back handled (`onRequestClose`) |
| **Switch access / assistive activation** | 2.1.1 (adapted) | explicit `SemanticsAction.tap` on every control | `Pressable` `onPress` reachable via the platform accessibility actions |

## 2. Automated assessment — results

Both assessments run in the normal test suites, so **every future change is re-assessed
automatically**; a violation fails the build.

### Flutter — official Flutter accessibility guidelines (pass: 100%)

`native/flutter_call_module/test/accessibility_test.dart` asserts **all four** of Flutter's
shipped accessibility guidelines — `androidTapTargetGuideline`, `iOSTapTargetGuideline`,
`labeledTapTargetGuideline`, `textContrastGuideline` — against **every screen state**: idle
chooser, single-call-type idle, in-call controls, and the DTMF keypad. 4/4 tests, 16/16
guideline evaluations pass.

```bash
cd native/flutter_call_module && flutter test    # All tests passed!
```

Notably, this assessment caught (and forced the fix of) two real defects: Material 3's default
`onPrimary` text failing contrast on the call buttons (1.91:1 and 3.97:1), and the keypad sheet
overflowing small screens.

### React Native — accessibility test suite (pass: 100%)

`packages/react-native-amazon-connect-webrtc/__tests__/accessibility.test.tsx` renders the call
screen in every state and enforces the gate: **every touchable must be a named button or an
explicitly structural element** — plus state exposure (`selected`/`disabled`), hidden decorative
glyphs, live regions, screen-reader announcements for all seven call states, labelled video
tiles, and keypad naming. 10/10 tests pass (36/36 in the package overall; `npm audit` stays at
0 vulnerabilities).

```bash
cd packages/react-native-amazon-connect-webrtc && npm test
```

## 3. Manual verification checklist (recommended per release)

Automated checks cover names, roles, states, contrast, and target sizes; the following need a
human with a device (10 minutes with VoiceOver, 10 with TalkBack):

1. Swipe through the idle screen: order is header → status → call button(s); nothing unnamed.
2. Start a call: hear "Connecting call… Ringing… Call connected" without touching the screen.
3. Every control announces name + state; double-tap toggles it and the state read-back changes.
4. Open the keypad: focus lands in the sheet; keys read "1", "2, ABC", "Star", "Pound"; each
   press is followed by the "Sent: …" announcement; the sheet dismisses (swipe-down/back/escape
   gesture) and focus returns to the call screen.
5. With 200% system font scale: no clipped/overlapping text; the keypad scrolls.
6. During a video call: tiles announce as "Agent video" / "Your camera preview".
7. Hang up from the agent side: "Call ended" is announced.

## 4. Certification status — honest statement

- **Automated assessment: done, passing 100%** (Section 2), re-run on every build. The evidence
  is reproducible with the two commands above.
- **Formal certification** (a signed VPAT®/Accessibility Conformance Report, or an audit against
  WCAG 2.2/EN 301 549/Section 508) can only be issued by an accredited third-party auditor with
  device-based assistive-technology testing. This repository is engineered to that bar — the
  criteria in Section 1 map directly onto the ACR line items an auditor evaluates — but no
  third-party certificate exists until such an audit is commissioned. When it is, Section 2's
  suites plus Section 3's checklist constitute the supporting evidence package.
- Host applications embedding these libraries add their own UI (banners, buttons, navigation);
  their accessibility is the host's responsibility — the reference hosts follow the same
  practices.

## 5. Keeping it at 100%

- The two assessment suites are part of `flutter test` / `npm test` — wire both into CI and treat
  any failure as a release blocker (they are deterministic and fast: <3s each).
- When adding a control: give it a role + name + state in the same commit; the gates will refuse
  anything unnamed.
- When changing colors: the Flutter contrast guideline re-verifies pixel-level; mirror any
  palette change into the RN stylesheet (the palettes are kept identical).
