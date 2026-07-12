import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'call_platform.dart';

/// Renders a single Chime video tile (local or remote) by hosting the native render view in a
/// PlatformView (`UiKitView` on iOS, `AndroidView` on Android). Obtain [tileId] from
/// `LocalVideoTileAdded` / `RemoteVideoTileAdded` events on `controller.events`.
class ConnectVideoView extends StatelessWidget {
  const ConnectVideoView({super.key, required this.tileId, this.mirror = false});

  final int tileId;

  /// Mirror horizontally — typically true for the local front-camera tile.
  final bool mirror;

  @override
  Widget build(BuildContext context) {
    final creationParams = <String, dynamic>{'tileId': tileId, 'mirror': mirror};

    switch (defaultTargetPlatform) {
      case TargetPlatform.iOS:
        return UiKitView(
          viewType: kVideoViewType,
          creationParams: creationParams,
          creationParamsCodec: const StandardMessageCodec(),
        );
      case TargetPlatform.android:
        return AndroidView(
          viewType: kVideoViewType,
          creationParams: creationParams,
          creationParamsCodec: const StandardMessageCodec(),
        );
      default:
        return const SizedBox.shrink();
    }
  }
}
