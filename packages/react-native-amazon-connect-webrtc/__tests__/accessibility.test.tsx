/**
 * Automated accessibility assessment for the prebuilt call UI. The gate: EVERY touchable in EVERY
 * screen state must expose a button role and a screen-reader name, state changes must be
 * announced, decorative glyphs must be hidden from assistive tech, and video surfaces must be
 * labelled. A failure here is a release blocker.
 */
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AccessibilityInfo } from './helpers/react-native-mock';
import { ConnectCallScreen, keypadKeyLabel, stateAnnouncement } from '../src/ConnectCallScreen';
import type { ConnectWebRtcController } from '../src/ConnectWebRtcController';
import type { CallEvent, CallState } from '../src/types';

type StateListener = (s: CallState) => void;
type EventListener = (e: CallEvent) => void;

function makeController(initialState: CallState = 'idle') {
  let state = initialState;
  const stateListeners: StateListener[] = [];
  const eventListeners: EventListener[] = [];
  const calls: string[] = [];

  const controller = {
    getState: () => state,
    get isInCall() {
      return ['connecting', 'ringing', 'connected', 'reconnecting'].includes(state);
    },
    onStateChanged(listener: StateListener) {
      stateListeners.push(listener);
      return () => undefined;
    },
    onEvent(listener: EventListener) {
      eventListeners.push(listener);
      return () => undefined;
    },
    startCall: async () => {
      calls.push('startCall');
    },
    endCall: async () => {
      calls.push('endCall');
    },
    sendDtmf: async (digits: string) => {
      calls.push(`sendDtmf:${digits}`);
    },
    setMuted: async () => true,
    setSpeakerphone: async () => undefined,
    enableLocalVideo: async () => undefined,
    disableLocalVideo: async () => undefined,
    switchCamera: async () => undefined,
  };

  return {
    controller: controller as unknown as ConnectWebRtcController,
    calls,
    pushState: (next: CallState) => {
      state = next;
      stateListeners.forEach((l) => l(next));
    },
    pushEvent: (e: CallEvent) => eventListeners.forEach((l) => l(e)),
  };
}

const mounted: ReactTestRenderer[] = [];

// Unmount everything so effect timers (the call-duration ticker) don't hold Jest open.
afterEach(async () => {
  while (mounted.length > 0) {
    const tree = mounted.pop()!;
    await act(async () => tree.unmount());
  }
});

async function renderScreen(
  initialState: CallState = 'idle',
  props: Record<string, unknown> = {},
) {
  const fake = makeController(initialState);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<ConnectCallScreen controller={fake.controller} {...props} />);
  });
  mounted.push(tree);
  return { tree, ...fake };
}

const pressables = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll((n) => String(n.type) === 'Pressable');

/** The 100% gate: every touchable is either a named button, or explicitly marked as a
 *  non-semantic structural element (`accessible={false}`) — nothing may be left ambiguous. */
function expectAllTouchablesAccessible(tree: ReactTestRenderer): void {
  const found = pressables(tree);
  expect(found.length).toBeGreaterThan(0);
  for (const p of found) {
    if (p.props.accessible === false) {
      // Structural (e.g. the keypad sheet's tap-catcher): must also be de-prioritised for AT.
      expect(p.props.importantForAccessibility).toBe('no');
      continue;
    }
    expect(p.props.accessibilityRole).toBe('button');
    expect(typeof p.props.accessibilityLabel).toBe('string');
    expect((p.props.accessibilityLabel as string).length).toBeGreaterThan(0);
  }
}

describe('idle chooser screen', () => {
  it('every touchable has a role and a name', async () => {
    const { tree } = await renderScreen('idle');
    expectAllTouchablesAccessible(tree);
    const labels = pressables(tree).map((p) => p.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(['Audio call', 'Video call']));
  });

  it('single-call-type mode still exposes an accessible dial button and hides nothing unlabelled', async () => {
    const { tree } = await renderScreen('disconnected', { enabledCallTypes: 'audio' });
    expectAllTouchablesAccessible(tree);
    const labels = pressables(tree).map((p) => p.props.accessibilityLabel);
    expect(labels).toContain('Audio call');
    expect(labels).not.toContain('Video call');
  });
});

describe('in-call controls', () => {
  it('every control has role, name and state; decorative glyphs are hidden', async () => {
    const { tree } = await renderScreen('connected');
    expectAllTouchablesAccessible(tree);

    const labels = pressables(tree).map((p) => p.props.accessibilityLabel);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Mute microphone',
        'Turn speaker on',
        'Turn camera on',
        'Open keypad',
        'Switch camera',
        'End call',
      ]),
    );

    // Control states are exposed (selected/disabled), not just implied visually.
    const flip = pressables(tree).find((p) => p.props.accessibilityLabel === 'Switch camera')!;
    expect(flip.props.accessibilityState).toEqual({ selected: false, disabled: true });

    // Emoji glyphs are presentation-only.
    // NOTE: '🎧' is excluded — it is also the decorative avatar glyph, which is hidden via its
    // parent wrapper (no-hide-descendants) rather than per-node.
    const glyphTexts = tree.root.findAll(
      (n) =>
        String(n.type) === 'Text' &&
        ['🎙', '🔊', '🔈', '🔢', '📞', '🚫', '🔄'].includes(n.props.children),
    );
    expect(glyphTexts.length).toBeGreaterThan(0);
    for (const glyph of glyphTexts) {
      expect(glyph.props.accessible).toBe(false);
      expect(glyph.props.importantForAccessibility).toBe('no');
    }
  });

  it('audio button mirrors the OS route: bluetooth/headset glyph + label, speaker selected', async () => {
    const { tree, pushEvent } = await renderScreen('connected');
    const speakerBtn = () =>
      pressables(tree).find((p) =>
        String(p.props.accessibilityLabel ?? '').includes('speaker'),
      )!;

    // Default (earpiece): plain speaker toggle.
    expect(speakerBtn().props.accessibilityLabel).toBe('Turn speaker on');

    await act(async () => pushEvent({ type: 'audioRouteChanged', route: 'bluetooth' }));
    expect(speakerBtn().props.accessibilityLabel).toBe('Audio on Bluetooth. Turn speaker on');
    const btLabel = tree.root.findAll(
      (n) => String(n.type) === 'Text' && n.props.children === 'Bluetooth',
    );
    expect(btLabel.length).toBe(1);

    await act(async () => pushEvent({ type: 'audioRouteChanged', route: 'headset' }));
    expect(speakerBtn().props.accessibilityLabel).toBe('Audio on headset. Turn speaker on');

    await act(async () => pushEvent({ type: 'audioRouteChanged', route: 'speaker' }));
    expect(speakerBtn().props.accessibilityLabel).toBe('Turn speaker off');
    expect(speakerBtn().props.accessibilityState).toEqual({ selected: true, disabled: false });
    expectAllTouchablesAccessible(tree);
  });

  it('audio-only config hides the video controls and stays fully labelled', async () => {
    const { tree } = await renderScreen('connected', { enabledCallTypes: 'audio' });
    expectAllTouchablesAccessible(tree);
    const labels = pressables(tree).map((p) => p.props.accessibilityLabel);
    expect(labels).not.toContain('Turn camera on');
    expect(labels).not.toContain('Switch camera');
    expect(labels).toContain('Mute microphone');
  });
});

describe('DTMF keypad', () => {
  it('names every key (Star/Pound, digits with letters) and announces sent digits', async () => {
    const { tree, calls } = await renderScreen('connected');

    const openKeypad = pressables(tree).find((p) => p.props.accessibilityLabel === 'Open keypad')!;
    await act(async () => openKeypad.props.onPress());

    expectAllTouchablesAccessible(tree);
    const labels = pressables(tree).map((p) => p.props.accessibilityLabel);
    expect(labels).toEqual(
      expect.arrayContaining(['Star', 'Pound', '1', '2, ABC', '0, +', 'Close keypad']),
    );

    const keyOne = pressables(tree).find((p) => p.props.accessibilityLabel === '1')!;
    await act(async () => keyOne.props.onPress());
    expect(calls).toContain('sendDtmf:1');

    // The dialed display is a polite live region announcing what was sent.
    const dialed = tree.root.findAll(
      (n) => String(n.type) === 'Text' && n.props.accessibilityLabel === 'Sent: 1',
    );
    expect(dialed).toHaveLength(1);
    expect(dialed[0]!.props.accessibilityLiveRegion).toBe('polite');
  });
});

describe('announcements and live regions', () => {
  beforeEach(() => (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear());

  it('announces every call-state transition to the screen reader', async () => {
    const { pushState } = await renderScreen('idle');
    await act(async () => pushState('connecting'));
    await act(async () => pushState('connected'));
    await act(async () => pushState('disconnected'));

    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Connecting call');
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Call connected');
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Call ended');
  });

  it('status is a polite live region; errors are assertive alerts', async () => {
    const { tree, pushEvent } = await renderScreen('idle');
    const status = tree.root.findAll(
      (n) => String(n.type) === 'Text' && n.props.accessibilityLiveRegion === 'polite',
    );
    expect(status.length).toBeGreaterThan(0);

    await act(async () =>
      pushEvent({ type: 'error', code: 'backendError', message: 'down', fatal: false }),
    );
    const alert = tree.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'alert');
    expect(alert).toHaveLength(1);
    expect(alert[0]!.props.accessibilityLiveRegion).toBe('assertive');
  });
});

describe('video surfaces', () => {
  it('remote and local tiles carry screen-reader labels', async () => {
    const { tree, pushEvent } = await renderScreen('connected');
    await act(async () => {
      pushEvent({ type: 'remoteVideoAvailable', tileId: 7, attendeeId: 'a' });
      pushEvent({ type: 'localVideoAvailable', tileId: 3 });
    });

    const tiles = tree.root.findAll((n) => String(n.type) === 'ConnectVideoView');
    expect(tiles.map((t) => t.props.accessibilityLabel).sort()).toEqual([
      'Agent video',
      'Your camera preview',
    ]);
    for (const tile of tiles) {
      expect(tile.props.accessible).toBe(true);
      expect(tile.props.accessibilityRole).toBe('image');
    }
  });
});

describe('naming helpers', () => {
  it('keypadKeyLabel gives symbols pronounceable names and digits their letters', () => {
    expect(keypadKeyLabel('*')).toBe('Star');
    expect(keypadKeyLabel('#')).toBe('Pound');
    expect(keypadKeyLabel('1', ' ')).toBe('1');
    expect(keypadKeyLabel('2', 'ABC')).toBe('2, ABC');
    expect(keypadKeyLabel('0', '+')).toBe('0, +');
  });

  it('stateAnnouncement covers every call state', () => {
    const states: CallState[] = [
      'idle', 'connecting', 'ringing', 'connected', 'reconnecting', 'disconnected', 'failed',
    ];
    for (const s of states) {
      expect(stateAnnouncement(s).length).toBeGreaterThan(0);
    }
  });
});
