require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'react-native-amazon-connect-webrtc'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/alokkulkarni/chimeflutter'
  s.license      = package['license']
  s.authors      = { 'chimeflutter' => 'noreply@example.com' }
  s.source       = { :git => 'https://github.com/alokkulkarni/chimeflutter.git', :tag => "v#{s.version}" }

  # iOS 15 floor: CallKit's CXProviderConfiguration() needs 14+; keep parity with the Flutter plugin.
  s.platforms    = { :ios => '15.0' }
  s.swift_version = '5.0'
  s.source_files = 'ios/**/*.{swift,h,m}'

  s.dependency 'React-Core'
  # Amazon Chime SDK for iOS (media plane) — same pin as the Flutter plugin.
  s.dependency 'AmazonChimeSDK', '~> 0.27.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
