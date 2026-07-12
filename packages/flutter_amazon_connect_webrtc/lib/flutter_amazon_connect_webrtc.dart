/// Amazon Connect in-app VoIP / video calling for Flutter, backed by the native Amazon Chime SDK.
///
/// Typical use:
/// ```dart
/// final controller = ConnectWebRtcController(
///   config: ConnectWebRtcConfig(backendBaseUrl: Uri.parse('https://…/v1')),
///   tokenProvider: () => myAuth.getJwt(),
/// );
/// await controller.startCall(CallRequest(
///   callType: CallType.audio,
///   device: DeviceInfo.forCurrentPlatform(appVersion: '4.2.0'),
///   context: {'issueType': 'billing', 'tier': 'gold'},
/// ));
/// ```
library flutter_amazon_connect_webrtc;

export 'src/backend_client.dart' show BackendClient;
export 'src/call_platform.dart' show CallPlatform, kMethodChannelName, kEventChannelName, kVideoViewType;
export 'src/connect_video_view.dart';
export 'src/connect_webrtc_config.dart' show ConnectWebRtcConfig, TokenProvider;
export 'src/connect_webrtc_controller.dart';
export 'src/exceptions.dart';
export 'src/models/call_event.dart';
export 'src/models/call_models.dart';
export 'src/models/call_state.dart';
export 'src/permission_service.dart' show PermissionService, DefaultPermissionService;
