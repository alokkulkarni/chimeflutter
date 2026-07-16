import { BackendClient } from '../src/BackendClient';
import { ConnectWebRtcController } from '../src/ConnectWebRtcController';
import { BackendError, PermissionDeniedError } from '../src/errors';
import type { NativeBridge } from '../src/native';
import type { CallEvent, CallRequest, CallSession, CallState } from '../src/types';

const SESSION: CallSession = {
  contactId: 'contact-1',
  participantId: 'participant-1',
  participantToken: 'ptoken-1',
  callType: 'audio',
  meeting: {
    meetingId: 'meeting-1',
    mediaRegion: 'eu-west-2',
    mediaPlacement: { audioHostUrl: 'wss://a', signalingUrl: 'wss://s' },
  },
  attendee: { attendeeId: 'attendee-1', joinToken: 'jtoken-1' },
};

const REQUEST: CallRequest = {
  callType: 'audio',
  device: {
    platform: 'iOS',
    osVersion: '17.5',
    appVersion: '1.0.0',
    deviceModel: 'iPhone15,2',
    locale: 'en-GB',
    networkType: 'wifi',
  },
};

/** Fake native bridge that records calls and lets tests push events. */
function makeBridge(overrides: Partial<NativeBridge> = {}) {
  let emit: (e: CallEvent) => void = () => undefined;
  const calls: string[] = [];
  const bridge: NativeBridge = {
    ensurePermissions: async () => true,
    join: async (_session, _callKit, _name, asIncoming) => {
      calls.push(asIncoming ? 'joinIncoming' : 'join');
    },
    leave: async () => {
      calls.push('leave');
    },
    setMuted: async (m) => {
      calls.push(`setMuted:${m}`);
      return true;
    },
    setLocalVideoEnabled: async (e) => {
      calls.push(`setLocalVideoEnabled:${e}`);
    },
    switchCamera: async () => {
      calls.push('switchCamera');
    },
    setSpeakerphoneEnabled: async (e) => {
      calls.push(`setSpeakerphoneEnabled:${e}`);
    },
    reportIncomingCall: async (callId) => {
      calls.push(`reportIncoming:${callId}`);
    },
    dismissIncomingCall: async () => {
      calls.push('dismissIncoming');
    },
    getPendingIncomingCall: async () => null,
    addEventListener: (listener) => {
      emit = listener;
      return () => undefined;
    },
    ...overrides,
  };
  return { bridge, calls, pushEvent: (e: CallEvent) => emit(e) };
}

/** Backend client with programmable fetch responses. */
function makeBackend(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return new BackendClient(
    { baseUrl: 'https://api.example.com/v1', tokenProvider: () => '' },
    {
      fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) =>
        handler(String(url), init)) as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0.5,
    },
  );
}

const okBackend = () =>
  makeBackend((url) => {
    if (url.endsWith('/calls')) {
      return new Response(JSON.stringify(SESSION), { status: 201 });
    }
    if (url.endsWith('/connections')) {
      return new Response(JSON.stringify({ connectionToken: 'ctoken-1' }), { status: 201 });
    }
    if (url.endsWith('/dtmf')) {
      return new Response(JSON.stringify({ sent: true }), { status: 200 });
    }
    return new Response(null, { status: 204 }); // DELETE /calls/{id}
  });

function makeController(bridge: NativeBridge, backendClient = okBackend()) {
  return new ConnectWebRtcController(
    { backendBaseUrl: 'https://api.example.com/v1', callKitEnabled: true },
    () => '',
    { backendClient, bridge },
  );
}

describe('startCall', () => {
  it('walks idle → connecting → ringing, then native events drive connected', async () => {
    const { bridge, calls, pushEvent } = makeBridge();
    const controller = makeController(bridge);
    const states: CallState[] = [];
    controller.onStateChanged((s) => states.push(s));

    await controller.startCall(REQUEST);
    expect(states).toEqual(['connecting', 'ringing']);
    expect(calls).toEqual(['join']);
    expect(controller.getSession()?.contactId).toBe('contact-1');

    pushEvent({ type: 'stateChanged', state: 'connected' });
    expect(controller.getState()).toBe('connected');
    expect(controller.isInCall).toBe(true);
  });

  it('fails fast with PermissionDeniedError and never touches the backend', async () => {
    const { bridge } = makeBridge({ ensurePermissions: async () => false });
    const backend = makeBackend(() => {
      throw new Error('backend must not be called');
    });
    const controller = makeController(bridge, backend);

    await expect(controller.startCall(REQUEST)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(controller.getState()).toBe('failed');
  });

  it('sets failed and rethrows when the backend rejects', async () => {
    const { bridge } = makeBridge();
    const backend = makeBackend(
      () => new Response(JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'down' } }), { status: 502 }),
    );
    const controller = makeController(bridge, backend);

    await expect(controller.startCall(REQUEST)).rejects.toBeInstanceOf(BackendError);
    expect(controller.getState()).toBe('failed');
  });

  it('rejects a second call while one is active', async () => {
    const { bridge } = makeBridge();
    const controller = makeController(bridge);
    await controller.startCall(REQUEST);
    await expect(controller.startCall(REQUEST)).rejects.toThrow('already in progress');
  });
});

describe('native events', () => {
  it('clears the session on terminal states and forwards events to listeners', async () => {
    const { bridge, pushEvent } = makeBridge();
    const controller = makeController(bridge);
    const events: CallEvent[] = [];
    controller.onEvent((e) => events.push(e));

    await controller.startCall(REQUEST);
    pushEvent({ type: 'stateChanged', state: 'connected' });
    pushEvent({ type: 'muteChanged', muted: true });
    pushEvent({ type: 'stateChanged', state: 'disconnected' });

    expect(events.map((e) => e.type)).toEqual(['stateChanged', 'muteChanged', 'stateChanged']);
    expect(controller.getSession()).toBeNull();
    expect(controller.getState()).toBe('disconnected');
  });

  it('marks the call failed on a fatal error event', async () => {
    const { bridge, pushEvent } = makeBridge();
    const controller = makeController(bridge);
    await controller.startCall(REQUEST);

    pushEvent({ type: 'error', code: 'sessionEnded', message: 'meeting ended', fatal: true });
    expect(controller.getState()).toBe('failed');
    expect(controller.getSession()).toBeNull();
  });
});

describe('endCall', () => {
  it('leaves the native session, best-effort stops server-side, resets state', async () => {
    const deleted: string[] = [];
    const backend = makeBackend((url, init) => {
      if (url.endsWith('/calls')) return new Response(JSON.stringify(SESSION), { status: 201 });
      if (init?.method === 'DELETE') {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    const { bridge, calls } = makeBridge();
    const controller = makeController(bridge, backend);

    await controller.startCall(REQUEST);
    await controller.endCall();
    // Give the fire-and-forget DELETE a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual(['join', 'leave']);
    expect(deleted).toEqual(['https://api.example.com/v1/calls/contact-1']);
    expect(controller.getState()).toBe('disconnected');
    expect(controller.getSession()).toBeNull();
  });

  it('still tears down locally when the server-side stop fails', async () => {
    const backend = makeBackend((url, init) => {
      if (url.endsWith('/calls') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify(SESSION), { status: 201 });
      }
      return new Response(JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'x' } }), { status: 502 });
    });
    const { bridge } = makeBridge();
    const controller = makeController(bridge, backend);

    await controller.startCall(REQUEST);
    await expect(controller.endCall()).resolves.toBeUndefined();
    expect(controller.getState()).toBe('disconnected');
  });
});

describe('sendDtmf', () => {
  it('creates the participant connection lazily once and reuses it', async () => {
    let connections = 0;
    const dtmfBodies: string[] = [];
    const backend = makeBackend((url, init) => {
      if (url.endsWith('/calls')) return new Response(JSON.stringify(SESSION), { status: 201 });
      if (url.endsWith('/connections')) {
        connections += 1;
        return new Response(JSON.stringify({ connectionToken: `ctoken-${connections}` }), { status: 201 });
      }
      if (url.endsWith('/dtmf')) {
        dtmfBodies.push(String(init?.body));
        return new Response(JSON.stringify({ sent: true }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const { bridge } = makeBridge();
    const controller = makeController(bridge, backend);

    await controller.startCall(REQUEST);
    await controller.sendDtmf('1');
    await controller.sendDtmf('2');

    expect(connections).toBe(1);
    expect(dtmfBodies.map((b) => JSON.parse(b).connectionToken)).toEqual(['ctoken-1', 'ctoken-1']);
  });

  it('recreates the connection once when the token has expired', async () => {
    let connections = 0;
    let dtmfCalls = 0;
    const backend = makeBackend((url) => {
      if (url.endsWith('/calls')) return new Response(JSON.stringify(SESSION), { status: 201 });
      if (url.endsWith('/connections')) {
        connections += 1;
        return new Response(JSON.stringify({ connectionToken: `ctoken-${connections}` }), { status: 201 });
      }
      if (url.endsWith('/dtmf')) {
        dtmfCalls += 1;
        if (dtmfCalls === 1) {
          return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'expired' } }), { status: 403 });
        }
        return new Response(JSON.stringify({ sent: true }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const { bridge } = makeBridge();
    const controller = makeController(bridge, backend);

    await controller.startCall(REQUEST);
    await controller.sendDtmf('1');
    expect(connections).toBe(2);
    expect(dtmfCalls).toBe(2);
  });

  it('throws without an active call and rejects invalid digits before the network', async () => {
    const { bridge } = makeBridge();
    const controller = makeController(bridge);
    await expect(controller.sendDtmf('1')).rejects.toThrow('No active call');

    await controller.startCall(REQUEST);
    await expect(controller.sendDtmf('abc')).rejects.toMatchObject({ code: 'INVALID_DTMF' });
  });
});

describe('controls pass through to the native bridge', () => {
  it('forwards mute/video/camera/speaker', async () => {
    const { bridge, calls } = makeBridge();
    const controller = makeController(bridge);
    await controller.startCall(REQUEST);

    await controller.setMuted(true);
    await controller.enableLocalVideo();
    await controller.disableLocalVideo();
    await controller.switchCamera();
    await controller.setSpeakerphone(true);

    expect(calls).toEqual([
      'join',
      'setMuted:true',
      'setLocalVideoEnabled:true',
      'setLocalVideoEnabled:false',
      'switchCamera',
      'setSpeakerphoneEnabled:true',
    ]);
  });
});

describe('simulated outbound (incoming calls)', () => {
  const outboundBackend = () =>
    makeBackend((url) => {
      if (url.endsWith('/answer')) {
        return new Response(JSON.stringify(SESSION), { status: 200 });
      }
      if (url.endsWith('/decline')) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no' } }), {
        status: 404,
      });
    });

  it('answerIncomingCall exchanges the callId and joins asIncoming', async () => {
    const { bridge, calls, pushEvent } = makeBridge();
    const controller = makeController(bridge, outboundBackend());
    const states: CallState[] = [];
    controller.onStateChanged((s) => states.push(s));

    await controller.answerIncomingCall('call-1');

    expect(states).toEqual(['connecting']);
    expect(calls).toEqual(['joinIncoming']);
    expect(controller.getSession()?.contactId).toBe('contact-1');

    pushEvent({ type: 'stateChanged', state: 'connected' });
    expect(controller.getState()).toBe('connected');
  });

  it('answerIncomingCall with denied permissions never hits the backend', async () => {
    const { bridge, calls } = makeBridge({ ensurePermissions: async () => false });
    const controller = makeController(bridge, outboundBackend());
    await expect(controller.answerIncomingCall('call-1')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(controller.getState()).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('answerIncomingCall surfaces a 410 (no longer ringing) and fails the state', async () => {
    const gone = makeBackend(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'CALL_NO_LONGER_RINGING', message: 'gone' } }),
          { status: 410 },
        ),
    );
    const { bridge } = makeBridge();
    const controller = makeController(bridge, gone);
    await expect(controller.answerIncomingCall('call-1')).rejects.toMatchObject({
      code: 'CALL_NO_LONGER_RINGING',
    });
    expect(controller.getState()).toBe('failed');
  });

  it('declineIncomingCall dismisses the ring UI and tells the backend', async () => {
    let declined = false;
    const backend = makeBackend((url) => {
      if (url.endsWith('/decline')) {
        declined = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    const { bridge, calls } = makeBridge();
    const controller = makeController(bridge, backend);

    await controller.declineIncomingCall('call-1');

    expect(calls).toEqual(['dismissIncoming']);
    expect(declined).toBe(true);
  });

  it('reportIncomingCall is forwarded to the native bridge', async () => {
    const { bridge, calls } = makeBridge();
    const controller = makeController(bridge, outboundBackend());
    await controller.reportIncomingCall('call-9', 'Acme Support', true, 30);
    expect(calls).toEqual(['reportIncoming:call-9']);
  });

  it('handlePendingIncomingCall answers a parked cold-start call', async () => {
    const { bridge, calls } = makeBridge({
      getPendingIncomingCall: async () => ({ callId: 'call-7', isVideo: false }),
    });
    const controller = makeController(bridge, outboundBackend());

    await expect(controller.handlePendingIncomingCall()).resolves.toBe(true);
    expect(calls).toEqual(['joinIncoming']);
  });

  it('handlePendingIncomingCall is a no-op when nothing is parked', async () => {
    const { bridge, calls } = makeBridge();
    const controller = makeController(bridge, outboundBackend());
    await expect(controller.handlePendingIncomingCall()).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('cannot answer while another call is active', async () => {
    const { bridge } = makeBridge();
    const controller = makeController(bridge);
    await controller.startCall(REQUEST);
    await expect(controller.answerIncomingCall('call-1')).rejects.toThrow(
      'A call is already in progress',
    );
  });
});
