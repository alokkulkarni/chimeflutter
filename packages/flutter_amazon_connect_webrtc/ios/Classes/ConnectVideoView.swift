import AmazonChimeSDK
import Flutter
import UIKit

/// Factory for the video-tile PlatformView. Hosts Chime's `DefaultVideoRenderView` and binds it to
/// the requested tile via the ``ChimeCallManager``.
class ConnectVideoViewFactory: NSObject, FlutterPlatformViewFactory {
    private let callManager: ChimeCallManager

    init(callManager: ChimeCallManager) {
        self.callManager = callManager
        super.init()
    }

    func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
        ConnectVideoPlatformView(frame: frame, args: args as? [String: Any], callManager: callManager)
    }

    func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
        FlutterStandardMessageCodec.sharedInstance()
    }
}

class ConnectVideoPlatformView: NSObject, FlutterPlatformView {
    private let renderView: DefaultVideoRenderView
    private let tileId: Int
    private weak var callManager: ChimeCallManager?

    init(frame: CGRect, args: [String: Any]?, callManager: ChimeCallManager) {
        self.tileId = (args?["tileId"] as? Int) ?? -1
        self.callManager = callManager
        self.renderView = DefaultVideoRenderView(frame: frame)
        super.init()

        if let mirror = args?["mirror"] as? Bool {
            renderView.mirror = mirror
        }
        if tileId >= 0 {
            callManager.bindVideoView(renderView, tileId: tileId)
        }
    }

    func view() -> UIView { renderView }

    deinit {
        if tileId >= 0 {
            callManager?.unbindVideoView(tileId: tileId)
        }
    }
}
