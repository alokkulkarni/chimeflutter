import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';

/// Configure at run time:
///   flutter run \
///     --dart-define=BACKEND_BASE_URL=https://abc.execute-api.eu-west-2.amazonaws.com/v1 \
///     --dart-define=DEMO_JWT=<optional bearer token for your own API auth>
const String kBackendBaseUrl = String.fromEnvironment(
  'BACKEND_BASE_URL',
  defaultValue: 'https://example.execute-api.eu-west-2.amazonaws.com/v1',
);
const String kDemoJwt = String.fromEnvironment('DEMO_JWT');

void main() => runApp(const ExampleApp());

/// The bearer token the plugin sends. Supply your app's own session token via --dart-define
/// (empty = no Authorization header; pair with your own auth in front of the backend API).
Future<String> tokenProvider() async => kDemoJwt;

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ChimeFlutter Example',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const CallScreen(),
    );
  }
}

class CallScreen extends StatefulWidget {
  const CallScreen({super.key});

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  late final ConnectWebRtcController _controller;
  final List<int> _remoteTiles = <int>[];
  int? _localTile;
  bool _muted = false;
  StreamSubscription<CallEvent>? _eventSub;
  String? _lastError;

  @override
  void initState() {
    super.initState();
    _controller = ConnectWebRtcController(
      config: ConnectWebRtcConfig(backendBaseUrl: Uri.parse(kBackendBaseUrl)),
      tokenProvider: tokenProvider,
    );
    _eventSub = _controller.events.listen(_onEvent);
  }

  void _onEvent(CallEvent event) {
    setState(() {
      switch (event) {
        case RemoteVideoTileAdded(:final tileId):
          if (!_remoteTiles.contains(tileId)) _remoteTiles.add(tileId);
        case LocalVideoTileAdded(:final tileId):
          _localTile = tileId;
        case VideoTileRemoved(:final tileId):
          _remoteTiles.remove(tileId);
          if (_localTile == tileId) _localTile = null;
        case MuteChanged(:final muted):
          _muted = muted;
        case CallErrorEvent(:final message):
          _lastError = message;
        default:
          break;
      }
    });
  }

  Future<void> _start(CallType type) async {
    setState(() => _lastError = null);
    try {
      await _controller.startCall(
        CallRequest(
          callType: type,
          device: DeviceInfo.forCurrentPlatform(appVersion: '1.0.0'),
          context: const {'issueType': 'billing', 'tier': 'gold'},
        ),
      );
    } on ConnectWebRtcException catch (e) {
      setState(() => _lastError = '${e.code}: ${e.message}');
    }
  }

  Future<void> _toggleMute() => _controller.setMuted(!_muted);

  @override
  void dispose() {
    _eventSub?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Call support'),
      ),
      body: ValueListenableBuilder<CallState>(
        valueListenable: _controller.state,
        builder: (context, state, _) {
          return Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('State: ${state.name}', style: Theme.of(context).textTheme.titleLarge),
                if (_lastError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_lastError!, style: const TextStyle(color: Colors.red)),
                  ),
                const SizedBox(height: 16),
                Expanded(child: _videoArea(state)),
                const SizedBox(height: 16),
                _controls(state),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _videoArea(CallState state) {
    if (_remoteTiles.isEmpty && _localTile == null) {
      return Center(
        child: Icon(
          state.isActive ? Icons.call : Icons.headset_mic,
          size: 96,
          color: Colors.grey,
        ),
      );
    }
    return Stack(
      children: [
        if (_remoteTiles.isNotEmpty)
          Positioned.fill(child: ConnectVideoView(tileId: _remoteTiles.first)),
        if (_localTile != null)
          Positioned(
            right: 8,
            bottom: 8,
            width: 110,
            height: 160,
            child: ConnectVideoView(tileId: _localTile!, mirror: true),
          ),
      ],
    );
  }

  Widget _controls(CallState state) {
    if (!state.isActive) {
      return Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          FilledButton.icon(
            onPressed: () => _start(CallType.audio),
            icon: const Icon(Icons.call),
            label: const Text('Audio call'),
          ),
          FilledButton.icon(
            onPressed: () => _start(CallType.video),
            icon: const Icon(Icons.videocam),
            label: const Text('Video call'),
          ),
        ],
      );
    }
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        IconButton.filledTonal(
          onPressed: _toggleMute,
          icon: Icon(_muted ? Icons.mic_off : Icons.mic),
          tooltip: _muted ? 'Unmute' : 'Mute',
        ),
        IconButton.filledTonal(
          onPressed: _controller.enableLocalVideo,
          icon: const Icon(Icons.videocam),
          tooltip: 'Enable video',
        ),
        IconButton.filledTonal(
          onPressed: _controller.switchCamera,
          icon: const Icon(Icons.cameraswitch),
          tooltip: 'Switch camera',
        ),
        IconButton.filled(
          onPressed: _controller.endCall,
          style: IconButton.styleFrom(backgroundColor: Colors.red),
          icon: const Icon(Icons.call_end, color: Colors.white),
          tooltip: 'End call',
        ),
      ],
    );
  }
}
