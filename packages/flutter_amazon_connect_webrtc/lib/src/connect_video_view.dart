import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'call_platform.dart';

/// Renders a single Chime video tile (local or remote) by hosting the native render view in a
/// PlatformView (`UiKitView` on iOS, `AndroidView` on Android). Obtain [tileId] from
/// `LocalVideoTileAdded` / `RemoteVideoTileAdded` events on `controller.events`.
class ConnectVideoView extends StatelessWidget {
  const ConnectVideoView({
    super.key,
    required this.tileId,
    this.mirror = false,
    this.semanticsLabel = 'Call video',
  });

  final int tileId;

  /// Mirror horizontally — typically true for the local front-camera tile.
  final bool mirror;

  /// Announced by screen readers (VoiceOver/TalkBack) for the video surface — e.g. "Agent video"
  /// for the remote tile or "Your camera preview" for the local one.
  final String semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final creationParams = <String, dynamic>{'tileId': tileId, 'mirror': mirror};

    final Widget view;
    switch (defaultTargetPlatform) {
      case TargetPlatform.iOS:
        view = UiKitView(
          viewType: kVideoViewType,
          creationParams: creationParams,
          creationParamsCodec: const StandardMessageCodec(),
        );
      case TargetPlatform.android:
        view = AndroidView(
          viewType: kVideoViewType,
          creationParams: creationParams,
          creationParamsCodec: const StandardMessageCodec(),
        );
      default:
        view = const SizedBox.shrink();
    }
    return Semantics(image: true, label: semanticsLabel, child: view);
  }
}
