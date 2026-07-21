import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';

/// Default entrypoint (standalone `flutter run`).
Future<void> main() => _bootstrap();

/// Add-to-app entrypoint the native hosts run on their cached FlutterEngine.
@pragma('vm:entry-point')
Future<void> mainHost() => _bootstrap();

Future<void> _bootstrap() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const BootstrapApp());
}

/// Runtime configuration. In add-to-app, dart-defines do NOT flow through the embedded engine, so
/// the native host supplies these over the bridge (`getConfig`); standalone runs use dart-defines.
class AppConfig {
  const AppConfig({required this.backendBaseUrl, required this.enabledCallTypes});

  final String backendBaseUrl;

  /// Which call types the support UI offers. Both (the default) shows the audio/video chooser;
  /// exactly one skips the chooser and dials that type immediately (see [soleCallType]).
  final Set<CallType> enabledCallTypes;

  bool get isReady => backendBaseUrl.startsWith('http');

  bool get videoEnabled => enabledCallTypes.contains(CallType.video);

  /// Non-null when exactly one call type is enabled — the type to dial without asking.
  CallType? get soleCallType => enabledCallTypes.length == 1 ? enabledCallTypes.first : null;

  static const String _defineBackend = String.fromEnvironment('BACKEND_BASE_URL');
  static const String _defineCallTypes = String.fromEnvironment('ENABLED_CALL_TYPES');

  /// Parses `"audio,video"` / `"audio"` / `"video"` (case- and space-tolerant). Empty or
  /// unrecognised input falls back to both — a typo must never remove the ability to call.
  static Set<CallType> parseCallTypes(String raw) {
    final tokens = raw.toLowerCase().split(',').map((t) => t.trim()).toSet();
    final types = <CallType>{
      if (tokens.contains('audio')) CallType.audio,
      if (tokens.contains('video')) CallType.video,
    };
    return types.isEmpty ? {CallType.audio, CallType.video} : types;
  }

  /// Host bridge values win over dart-defines; missing values fall back.
  static Future<AppConfig> load() async {
    var backend = _defineBackend;
    var callTypes = _defineCallTypes;
    try {
      final raw = await HostBridge.getConfig();
      backend = (raw['backendBaseUrl'] ?? '').isNotEmpty ? raw['backendBaseUrl']! : backend;
      callTypes =
          (raw['enabledCallTypes'] ?? '').isNotEmpty ? raw['enabledCallTypes']! : callTypes;
    } catch (_) {
      // No host handler (standalone run) — dart-defines only.
    }
    return AppConfig(
      backendBaseUrl: backend,
      enabledCallTypes: parseCallTypes(callTypes),
    );
  }
}

/// Bidirectional bridge to the native host: config/auth/context in, call state out, call control in.
class HostBridge {
  HostBridge(this._controller) {
    _channel.setMethodCallHandler(_onHostCall);
    _controller.states.listen((state) {
      _channel.invokeMethod('onCallStateChanged', {'state': state.name});
      if (state == CallState.disconnected || state == CallState.failed) {
        _channel.invokeMethod('onCallEnded', {'state': state.name});
      }
    });
  }

  static const MethodChannel _channel = MethodChannel('com.chimeflutter.host/bridge');
  final ConnectWebRtcController _controller;

  static Future<Map<String, String>> getConfig() async {
    final raw = await _channel.invokeMapMethod<String, dynamic>('getConfig') ?? {};
    return raw.map((key, value) => MapEntry(key, '${value ?? ''}'));
  }

  static Future<String> getAuthToken() async =>
      (await _channel.invokeMethod<String>('getAuthToken')) ?? '';

  static Future<Map<String, String>> getCustomerContext() async {
    final raw = await _channel.invokeMapMethod<String, dynamic>('getCustomerContext') ?? {};
    return raw.map((key, value) => MapEntry(key, '$value'));
  }

  /// Asks the native host to hide the call screen so the user can browse the rest of the app.
  /// The call keeps running (native media session + cached engine); the host shows a
  /// "return to call" affordance.
  static Future<void> minimize() => _channel.invokeMethod('minimize');

  Future<dynamic> _onHostCall(MethodCall call) async {
    switch (call.method) {
      case 'startCall':
        final type = (call.arguments?['callType'] as String?) == 'video'
            ? CallType.video
            : CallType.audio;
        await _controller.startCall(CallRequest(
          callType: type,
          device: DeviceInfo.forCurrentPlatform(),
          context: await getCustomerContext(),
        ));
        return true;
      case 'endCall':
        await _controller.endCall();
        return true;
      case 'setMuted':
        await _controller.setMuted(call.arguments?['muted'] as bool? ?? false);
        return true;
      default:
        throw PlatformException(code: 'unimplemented', message: 'Unknown host call ${call.method}');
    }
  }
}

/// The bearer token the plugin sends with backend requests. The native host owns authentication —
/// return its session token here (empty = no Authorization header; fine for the auth-free demo
/// backend, but front the API with your own auth before production).
Future<String> tokenProvider() => HostBridge.getAuthToken();

class BootstrapApp extends StatelessWidget {
  const BootstrapApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        useMaterial3: true,
        brightness: Brightness.dark,
      ),
      home: FutureBuilder<AppConfig>(
        future: AppConfig.load(),
        builder: (context, snap) {
          if (!snap.hasData) {
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          }
          final config = snap.data!;
          if (!config.isReady) return SetupScreen(config: config);
          return CallHome(config: config);
        },
      ),
    );
  }
}

/// Shown instead of a cryptic "call failed" when the backend URL has not been provided.
class SetupScreen extends StatelessWidget {
  const SetupScreen({super.key, required this.config});
  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.settings_suggest, size: 56, color: Colors.amber),
            const SizedBox(height: 16),
            Text('Backend not configured', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 12),
            const Text(
              'The call service URL is missing, so calls cannot be placed yet.\n\n'
              '1. Deploy the backend (docs/DEPLOYMENT.md) and copy the ApiBaseUrl output.\n'
              '2. Native app: paste it into HostConfig.backendBaseUrl (iOS AppDelegate.swift / '
              'Android HostApplication.kt).\n'
              '3. Standalone: pass --dart-define=BACKEND_BASE_URL=https://…/v1.',
              style: TextStyle(height: 1.4),
            ),
            const SizedBox(height: 12),
            Text(
              'Current value: "${config.backendBaseUrl.isEmpty ? '(empty)' : config.backendBaseUrl}"',
              style: const TextStyle(color: Colors.white70),
            ),
          ],
        ),
      ),
    );
  }
}

/// The call surface: WhatsApp-style dark call screen with avatar, state, duration and controls.
class CallHome extends StatefulWidget {
  const CallHome({super.key, required this.config, this.controllerOverride});
  final AppConfig config;

  /// Test seam — widget/accessibility tests inject a controller wired to fakes.
  final ConnectWebRtcController? controllerOverride;

  @override
  State<CallHome> createState() => _CallHomeState();
}

class _CallHomeState extends State<CallHome> {
  late final ConnectWebRtcController _controller;
  int? _remoteTile;
  int? _localTile;
  String? _error;
  bool _muted = false;
  bool _speakerOn = false;
  bool _videoOn = false;

  /// The ACTIVE audio output as reported by the OS (`speaker | receiver | bluetooth | headset`) —
  /// drives the audio button's icon/label like the system call screen's route indicator.
  String _route = 'receiver';
  Timer? _ticker;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _controller = widget.controllerOverride ??
        ConnectWebRtcController(
          config: ConnectWebRtcConfig(
            backendBaseUrl: Uri.parse(widget.config.backendBaseUrl),
            callKitEnabled: true, // report to CallKit (iOS) / Telecom (Android)
            callDisplayName: 'Support',
          ),
          tokenProvider: tokenProvider,
        );
    HostBridge(_controller); // wire native ⇄ Flutter (kept alive by its handler + subscription)
    _controller.states.listen(_onState);
    _controller.events.listen(_onEvent);

    // Single-call-type mode: skip the audio/video chooser and dial immediately on open. Only on
    // first entry — after a call ends the idle screen shows a single redial button instead, so a
    // hangup can never loop back into a new call.
    final sole = widget.config.soleCallType;
    if (sole != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_controller.isInCall) _start(sole);
      });
    }
  }

  void _onState(CallState state) {
    if (state == CallState.connected && _ticker == null) {
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        setState(() => _elapsed += const Duration(seconds: 1));
      });
    }
    if (state.isTerminal) {
      _ticker?.cancel();
      _ticker = null;
      _muted = false;
      _speakerOn = false;
      _videoOn = false;
      _route = 'receiver';
      _elapsed = Duration.zero;
    }
    setState(() {});
  }

  void _onEvent(CallEvent e) {
    setState(() {
      if (e is RemoteVideoTileAdded) _remoteTile = e.tileId;
      if (e is LocalVideoTileAdded) _localTile = e.tileId;
      if (e is VideoTileRemoved) {
        if (_remoteTile == e.tileId) _remoteTile = null;
        if (_localTile == e.tileId) _localTile = null;
      }
      if (e is MuteChanged) _muted = e.muted;
      if (e is AudioRouteChanged) {
        _route = e.route;
        _speakerOn = e.route == 'speaker';
      }
      if (e is CallErrorEvent) _error = '${e.code}: ${e.message}';
    });
  }

  /// Routing context for UI-dialed calls — the native host's `getCustomerContext` map (the same
  /// source host-initiated calls use), so the host stays the single owner of customer context.
  /// Falls back to the demo values on a standalone `flutter run` (no host handler).
  Future<Map<String, String>> _routingContext() async {
    try {
      final context = await HostBridge.getCustomerContext();
      if (context.isNotEmpty) return context;
    } catch (_) {
      // No host handler (standalone run) — use the demo context below.
    }
    return const {'issueType': 'billing', 'tier': 'gold'};
  }

  Future<void> _start(CallType type) async {
    setState(() => _error = null);
    try {
      await _controller.startCall(CallRequest(
        callType: type,
        device: DeviceInfo.forCurrentPlatform(),
        context: await _routingContext(),
      ));
      if (type == CallType.video) {
        await _controller.enableLocalVideo();
        setState(() => _videoOn = true);
      }
    } on ConnectWebRtcException catch (e) {
      setState(() => _error = '${e.code}: ${e.message}');
    }
  }

  Future<void> _toggleVideo() async {
    if (_videoOn) {
      await _controller.disableLocalVideo();
    } else {
      await _controller.enableLocalVideo();
    }
    setState(() => _videoOn = !_videoOn);
  }

  /// Forces the speaker on, or — when already on speaker — hands routing back to the OS (which
  /// returns to bluetooth/headset when one is connected, else the earpiece). The button's state is
  /// driven by the resulting [AudioRouteChanged] event, not assumed here.
  Future<void> _toggleSpeaker() => _controller.setSpeakerphone(_route != 'speaker');

  @override
  void dispose() {
    _ticker?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ValueListenableBuilder<CallState>(
        valueListenable: _controller.state,
        builder: (context, state, _) {
          return Container(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0xFF1A1B33), Color(0xFF0D0E1A)],
              ),
            ),
            child: SafeArea(
              child: Stack(
                children: [
                  // Remote video fills the screen on a video call.
                  if (_remoteTile != null)
                    Positioned.fill(
                      child: ConnectVideoView(tileId: _remoteTile!, semanticsLabel: 'Agent video'),
                    ),
                  // Local preview, picture-in-picture.
                  if (_localTile != null)
                    Positioned(
                      right: 16,
                      top: 16,
                      width: 104,
                      height: 156,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(12),
                        child: ConnectVideoView(
                          tileId: _localTile!,
                          mirror: true,
                          semanticsLabel: 'Your camera preview',
                        ),
                      ),
                    ),
                  // Minimizing uses the platform-native gesture (no custom button): iOS — swipe the
                  // sheet down; Android — the system back gesture/button. The call keeps running
                  // (native media session + cached engine) and the host shows a green call bar.
                  Column(
                    children: [
                      const SizedBox(height: 24),
                      _header(state),
                      const Spacer(),
                      if (_remoteTile == null) _avatar(state),
                      const Spacer(),
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
                          // liveRegion: screen readers announce errors as they appear.
                          child: Semantics(
                            liveRegion: true,
                            child: Text(
                              _error!,
                              textAlign: TextAlign.center,
                              style: const TextStyle(color: Colors.redAccent),
                            ),
                          ),
                        ),
                      _controls(state),
                      const SizedBox(height: 32),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _header(CallState state) {
    return Column(
      children: [
        const Text(
          'Support',
          style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        // liveRegion: VoiceOver/TalkBack announce call-state changes (Connecting…, Connected…).
        Semantics(
          liveRegion: true,
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            child: Text(
              _statusLine(state),
              key: ValueKey<String>('${state.name}$_elapsed'),
              style: const TextStyle(color: Colors.white70, fontSize: 15),
            ),
          ),
        ),
      ],
    );
  }

  Widget _avatar(CallState state) {
    final pulsing = state == CallState.connecting || state == CallState.ringing;
    // Decorative — the header already conveys who the call is with and its state.
    return ExcludeSemantics(
      child: Column(
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 600),
            width: 132,
            height: 132,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: const Color(0xFF2A2C4E),
              border: Border.all(
                color: pulsing ? Colors.indigoAccent : Colors.white12,
                width: pulsing ? 3 : 1,
              ),
            ),
            child: const Icon(Icons.support_agent, size: 64, color: Colors.white70),
          ),
        ],
      ),
    );
  }

  String _statusLine(CallState state) => switch (state) {
        CallState.idle => 'Ready when you are',
        CallState.connecting => 'Connecting…',
        CallState.ringing => 'Ringing…',
        CallState.connected => _format(_elapsed),
        CallState.reconnecting => 'Reconnecting…',
        CallState.disconnected => 'Call ended',
        CallState.failed => 'Call failed',
      };

  String _format(Duration d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return d.inHours > 0
        ? '${d.inHours}:${two(d.inMinutes % 60)}:${two(d.inSeconds % 60)}'
        : '${two(d.inMinutes)}:${two(d.inSeconds % 60)}';
  }

  Widget _controls(CallState state) {
    if (!state.isActive) {
      final sole = widget.config.soleCallType;
      // One enabled call type → one full-width dial button (the chooser never appears; on first
      // open the call auto-starts, so this is mostly the post-call redial affordance).
      if (sole != null) {
        final video = sole == CallType.video;
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () => _start(sole),
              style: FilledButton.styleFrom(
                // White on green-800 / indigo-500 meets the WCAG 4.5:1 text contrast minimum
                // (M3's default dark onPrimary fails on these fills) — guarded by test.
                backgroundColor: video ? Colors.indigo.shade500 : Colors.green.shade800,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              icon: Icon(video ? Icons.videocam : Icons.call),
              label: Text(video ? 'Video call' : 'Audio call'),
            ),
          ),
        );
      }
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: () => _start(CallType.audio),
                style: FilledButton.styleFrom(
                  // White on green-800 meets WCAG 4.5:1 (M3's dark onPrimary fails here).
                  backgroundColor: Colors.green.shade800,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                icon: const Icon(Icons.call),
                label: const Text('Audio call'),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: FilledButton.icon(
                onPressed: () => _start(CallType.video),
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.indigo.shade500,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                icon: const Icon(Icons.videocam),
                label: const Text('Video call'),
              ),
            ),
          ],
        ),
      );
    }
    return Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _roundButton(
              icon: _muted ? Icons.mic_off : Icons.mic,
              active: _muted,
              label: 'Mute',
              onTap: () => _controller.setMuted(!_muted),
            ),
            // Mirrors the system call screen's route indicator: bluetooth/wired headsets show
            // their own icon + label, so the user can see where the audio actually is.
            _roundButton(
              icon: switch (_route) {
                'bluetooth' => Icons.bluetooth_audio,
                'headset' => Icons.headset,
                'speaker' => Icons.volume_up,
                _ => Icons.volume_down,
              },
              active: _speakerOn,
              label: switch (_route) {
                'bluetooth' => 'Bluetooth',
                'headset' => 'Headset',
                _ => 'Speaker',
              },
              onTap: _toggleSpeaker,
            ),
            if (widget.config.videoEnabled)
              _roundButton(
                icon: _videoOn ? Icons.videocam : Icons.videocam_off,
                active: _videoOn,
                label: 'Video',
                onTap: _toggleVideo,
              ),
            _roundButton(
              icon: Icons.dialpad,
              active: false,
              label: 'Keypad',
              onTap: _showKeypad,
            ),
            if (widget.config.videoEnabled)
              _roundButton(
                icon: Icons.cameraswitch,
                active: false,
                label: 'Flip',
                onTap: _videoOn ? _controller.switchCamera : null,
              ),
          ],
        ),
        const SizedBox(height: 28),
        SizedBox(
          width: 72,
          height: 72,
          child: FloatingActionButton(
            backgroundColor: Colors.red.shade600,
            tooltip: 'End call',
            onPressed: _controller.endCall,
            child: const Icon(Icons.call_end, size: 32),
          ),
        ),
      ],
    );
  }

  /// Phone-style DTMF keypad for IVR menus ("Press 1 for billing…"). Each tap sends the digit
  /// immediately via the Connect Participant Service.
  void _showKeypad() {
    var dialed = '';
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF1A1B33),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) {
          Future<void> tap(String digit) async {
            setSheetState(() => dialed += digit);
            try {
              await _controller.sendDtmf(digit);
            } catch (e) {
              setSheetState(() => dialed = 'send failed');
            }
          }

          // Screen-reader names: digits read as-is (with their letters), symbols by name.
          String keyLabel(String d, String? letters) => switch (d) {
                '*' => 'Star',
                '#' => 'Pound',
                _ => letters == null ? d : '$d, $letters',
              };

          Widget key(String d, [String? letters]) => Expanded(
                child: Semantics(
                  button: true,
                  label: keyLabel(d, letters),
                  onTap: () => tap(d),
                  excludeSemantics: true,
                  child: InkWell(
                    onTap: () => tap(d),
                    borderRadius: BorderRadius.circular(40),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Column(
                        children: [
                          Text(d, style: const TextStyle(color: Colors.white, fontSize: 30)),
                          Text(letters ?? ' ',
                              style: const TextStyle(color: Colors.white60, fontSize: 10)),
                        ],
                      ),
                    ),
                  ),
                ),
              );

          return SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 16, 24, 8),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // liveRegion: each sent digit is announced by the screen reader.
                  Semantics(
                    liveRegion: true,
                    label: dialed.isEmpty ? 'No digits entered yet' : 'Sent: $dialed',
                    excludeSemantics: true,
                    child: Text(
                      dialed.isEmpty ? 'Enter digits' : dialed,
                      style: TextStyle(
                        color: dialed.isEmpty ? Colors.white70 : Colors.white,
                        fontSize: 26,
                        letterSpacing: 4,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(children: [key('1'), key('2', 'ABC'), key('3', 'DEF')]),
                  Row(children: [key('4', 'GHI'), key('5', 'JKL'), key('6', 'MNO')]),
                  Row(children: [key('7', 'PQRS'), key('8', 'TUV'), key('9', 'WXYZ')]),
                  Row(children: [key('*'), key('0', '+'), key('#')]),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _roundButton({
    required IconData icon,
    required bool active,
    required String label,
    VoidCallback? onTap,
  }) {
    // One semantics node per control: explicit label + tap action, button role, and
    // enabled/selected state — the icon and caption below are presentation only.
    return Semantics(
      button: true,
      enabled: onTap != null,
      selected: active,
      label: label,
      onTap: onTap,
      excludeSemantics: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Material(
            color: active ? Colors.white : Colors.white12,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onTap,
              child: SizedBox(
                width: 60,
                height: 60,
                child: Icon(
                  icon,
                  color: onTap == null
                      ? Colors.white24
                      : active
                          ? Colors.black87
                          : Colors.white,
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(label, style: const TextStyle(color: Colors.white70, fontSize: 12)),
        ],
      ),
    );
  }
}
