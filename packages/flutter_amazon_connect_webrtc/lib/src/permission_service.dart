import 'package:permission_handler/permission_handler.dart';

import 'models/call_models.dart';

/// Requests and verifies the runtime permissions a call needs (FR-F6). Behind an interface so the
/// controller can be unit tested with a fake that never touches the OS.
abstract interface class PermissionService {
  /// Returns true only if microphone (and, for a video call, camera) permission is granted.
  Future<bool> ensureCallPermissions(CallType callType);
}

/// Default implementation backed by `permission_handler`.
class DefaultPermissionService implements PermissionService {
  const DefaultPermissionService();

  @override
  Future<bool> ensureCallPermissions(CallType callType) async {
    final mic = await Permission.microphone.request();
    if (!mic.isGranted) return false;
    if (callType == CallType.video) {
      final camera = await Permission.camera.request();
      if (!camera.isGranted) return false;
    }
    return true;
  }
}
