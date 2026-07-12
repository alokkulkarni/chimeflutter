#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTViewManager.h>

// Exposes the Swift module (ConnectWebrtcModule.swift, @objc(ConnectWebrtc)) to React Native.
@interface RCT_EXTERN_MODULE (ConnectWebrtc, RCTEventEmitter)

RCT_EXTERN_METHOD(requestPermissions:(BOOL)needsCamera
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(join:(NSDictionary *)args
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(leave:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setMuted:(BOOL)muted
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setLocalVideoEnabled:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(switchCamera:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setSpeakerphoneEnabled:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end

// Exposes the Swift view manager under the JS name `ConnectVideoView`.
@interface RCT_EXTERN_REMAP_MODULE (ConnectVideoView, ConnectVideoViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(tileId, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(mirror, BOOL)

@end
