#
# ChimeFlutter iOS plugin podspec.
# Depends on the Amazon Chime SDK for iOS (media plane). Version pinned per research:
# AmazonChimeSDK ~> 0.27 (transitively pulls AmazonChimeSDKMedia). Min iOS 13.
#
Pod::Spec.new do |s|
  s.name             = 'flutter_amazon_connect_webrtc'
  s.version          = '1.0.0'
  s.summary          = 'Amazon Connect in-app VoIP/video calling for Flutter via the Amazon Chime SDK.'
  s.description       = <<-DESC
Flutter plugin that joins an Amazon Connect WebRTC contact using the native Amazon Chime SDK.
                       DESC
  s.homepage         = 'https://example.com/chimeflutter'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'ChimeFlutter' => 'dev@example.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.dependency 'AmazonChimeSDK', '~> 0.27.0'
  # iOS 14 floor: CallKit's CXProviderConfiguration() initializer requires iOS 14+.
  s.platform         = :ios, '14.0'
  s.swift_version    = '5.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  # Unit tests for the pure adapter (run in CI with the pod installed).
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = 'Tests/**/*'
  end
end
