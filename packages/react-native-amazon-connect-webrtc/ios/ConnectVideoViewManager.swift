import AmazonChimeSDK
import React
import UIKit

/// UIView wrapper hosting Chime's `DefaultVideoRenderView`. Props arrive in any order, so binding
/// happens when `tileId` is set; unbinding happens when the view leaves the window.
class ConnectVideoContainerView: UIView {
    private let renderView = DefaultVideoRenderView(frame: .zero)
    private var boundTileId: Int = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        renderView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(renderView)
        NSLayoutConstraint.activate([
            renderView.topAnchor.constraint(equalTo: topAnchor),
            renderView.bottomAnchor.constraint(equalTo: bottomAnchor),
            renderView.leadingAnchor.constraint(equalTo: leadingAnchor),
            renderView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError("init(coder:) is not supported") }

    @objc var mirror: Bool = false {
        didSet { renderView.mirror = mirror }
    }

    @objc var tileId: NSNumber = -1 {
        didSet { bindIfNeeded() }
    }

    private func bindIfNeeded() {
        let tile = tileId.intValue
        guard tile >= 0, tile != boundTileId else { return }
        unbind()
        ChimeSessionHolder.shared.callManager?.bindVideoView(renderView, tileId: tile)
        boundTileId = tile
    }

    private func unbind() {
        guard boundTileId >= 0 else { return }
        ChimeSessionHolder.shared.callManager?.unbindVideoView(tileId: boundTileId)
        boundTileId = -1
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil { unbind() }
    }
}

@objc(ConnectVideoViewManager)
class ConnectVideoViewManager: RCTViewManager {
    override static func requiresMainQueueSetup() -> Bool { true }

    override func view() -> UIView! {
        ConnectVideoContainerView(frame: .zero)
    }
}
