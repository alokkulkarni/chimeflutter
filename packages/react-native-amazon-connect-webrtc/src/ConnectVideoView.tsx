import React from 'react';
import { requireNativeComponent, ViewProps } from 'react-native';

interface NativeProps extends ViewProps {
  tileId: number;
  mirror?: boolean;
}

const NativeConnectVideoView = requireNativeComponent<NativeProps>('ConnectVideoView');

export interface ConnectVideoViewProps extends ViewProps {
  /** The tile to render — from a `localVideoAvailable` / `remoteVideoAvailable` event. */
  tileId: number;
  /** Mirror the image (use for the local self-view). */
  mirror?: boolean;
  /** Announced by VoiceOver/TalkBack for the video surface — e.g. "Agent video" for the remote
   *  tile or "Your camera preview" for the local one. */
  accessibilityLabel?: string;
}

/** Renders one Chime video tile in the native `DefaultVideoRenderView` (no pixel copies through
 *  JS — the video never leaves the native layer). */
export function ConnectVideoView({
  tileId,
  mirror = false,
  accessibilityLabel = 'Call video',
  ...rest
}: ConnectVideoViewProps) {
  return (
    <NativeConnectVideoView
      tileId={tileId}
      mirror={mirror}
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      {...rest}
    />
  );
}
