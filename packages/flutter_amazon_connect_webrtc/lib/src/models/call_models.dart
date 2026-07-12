import 'dart:io' show Platform;

import 'package:meta/meta.dart';

/// The kind of call the customer is placing.
enum CallType {
  audio,
  video;

  /// Wire value sent to the backend (`"audio"` | `"video"`).
  String get wireName => name;

  static CallType fromWire(String value) {
    switch (value) {
      case 'audio':
        return CallType.audio;
      case 'video':
        return CallType.video;
      default:
        throw ArgumentError('Unknown callType: $value');
    }
  }
}

/// Device details attached to the call and forwarded to Amazon Connect as contact attributes
/// (`devicePlatform`, `appVersion`, …) to help routing/diagnostics.
@immutable
class DeviceInfo {
  const DeviceInfo({
    required this.platform,
    this.osVersion,
    this.appVersion,
    this.deviceModel,
    this.locale,
    this.networkType,
  });

  /// `"iOS"` or `"Android"`.
  final String platform;
  final String? osVersion;
  final String? appVersion;
  final String? deviceModel;
  final String? locale;
  final String? networkType;

  /// Builds a [DeviceInfo] for the current platform, letting the host supply app-level fields.
  factory DeviceInfo.forCurrentPlatform({
    String? osVersion,
    String? appVersion,
    String? deviceModel,
    String? networkType,
    String? locale,
  }) {
    final platform = Platform.isIOS
        ? 'iOS'
        : Platform.isAndroid
            ? 'Android'
            : Platform.operatingSystem;
    return DeviceInfo(
      platform: platform,
      osVersion: osVersion ?? Platform.operatingSystemVersion,
      appVersion: appVersion,
      deviceModel: deviceModel,
      locale: locale ?? Platform.localeName,
      networkType: networkType,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'platform': platform,
        if (osVersion != null) 'osVersion': osVersion,
        if (appVersion != null) 'appVersion': appVersion,
        if (deviceModel != null) 'deviceModel': deviceModel,
        if (locale != null) 'locale': locale,
        if (networkType != null) 'networkType': networkType,
      };
}

/// The request the host passes to `ConnectWebRtcController.startCall`.
@immutable
class CallRequest {
  const CallRequest({
    required this.callType,
    required this.device,
    this.displayName,
    this.context = const <String, String>{},
  });

  final CallType callType;
  final DeviceInfo device;

  /// Shown to the agent. Optional — the backend substitutes a default if omitted.
  final String? displayName;

  /// Free-form context. Only backend-allow-listed keys reach Connect.
  final Map<String, String> context;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'callType': callType.wireName,
        if (displayName != null) 'displayName': displayName,
        if (context.isNotEmpty) 'context': context,
        'device': device.toJson(),
      };
}

/// Chime media placement URLs (a subset of the Connect response).
@immutable
class MediaPlacement {
  const MediaPlacement({
    required this.audioHostUrl,
    required this.signalingUrl,
    this.audioFallbackUrl,
    this.turnControlUrl,
    this.eventIngestionUrl,
  });

  final String audioHostUrl;
  final String signalingUrl;
  final String? audioFallbackUrl;
  final String? turnControlUrl;
  final String? eventIngestionUrl;

  factory MediaPlacement.fromJson(Map<String, dynamic> json) => MediaPlacement(
        audioHostUrl: json['audioHostUrl'] as String,
        signalingUrl: json['signalingUrl'] as String,
        audioFallbackUrl: json['audioFallbackUrl'] as String?,
        turnControlUrl: json['turnControlUrl'] as String?,
        eventIngestionUrl: json['eventIngestionUrl'] as String?,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'audioHostUrl': audioHostUrl,
        'signalingUrl': signalingUrl,
        if (audioFallbackUrl != null) 'audioFallbackUrl': audioFallbackUrl,
        if (turnControlUrl != null) 'turnControlUrl': turnControlUrl,
        if (eventIngestionUrl != null) 'eventIngestionUrl': eventIngestionUrl,
      };
}

@immutable
class CallMeeting {
  const CallMeeting({
    required this.meetingId,
    required this.mediaPlacement,
    this.mediaRegion,
  });

  final String meetingId;
  final MediaPlacement mediaPlacement;
  final String? mediaRegion;

  factory CallMeeting.fromJson(Map<String, dynamic> json) => CallMeeting(
        meetingId: json['meetingId'] as String,
        mediaRegion: json['mediaRegion'] as String?,
        mediaPlacement:
            MediaPlacement.fromJson(Map<String, dynamic>.from(json['mediaPlacement'] as Map)),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'meetingId': meetingId,
        if (mediaRegion != null) 'mediaRegion': mediaRegion,
        'mediaPlacement': mediaPlacement.toJson(),
      };
}

@immutable
class CallAttendee {
  const CallAttendee({required this.attendeeId, required this.joinToken});

  final String attendeeId;
  final String joinToken;

  factory CallAttendee.fromJson(Map<String, dynamic> json) => CallAttendee(
        attendeeId: json['attendeeId'] as String,
        joinToken: json['joinToken'] as String,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'attendeeId': attendeeId,
        'joinToken': joinToken,
      };
}

/// The join credentials returned by the backend `POST /v1/calls`. This exact map (via [toJson]) is
/// what the native bridge turns into a Chime `MeetingSessionConfiguration`.
@immutable
class CallSession {
  const CallSession({
    required this.contactId,
    required this.participantId,
    required this.participantToken,
    required this.callType,
    required this.meeting,
    required this.attendee,
  });

  final String contactId;
  final String participantId;
  final String participantToken;
  final CallType callType;
  final CallMeeting meeting;
  final CallAttendee attendee;

  factory CallSession.fromJson(Map<String, dynamic> json) => CallSession(
        contactId: json['contactId'] as String,
        participantId: json['participantId'] as String,
        participantToken: json['participantToken'] as String,
        callType: CallType.fromWire(json['callType'] as String),
        meeting: CallMeeting.fromJson(Map<String, dynamic>.from(json['meeting'] as Map)),
        attendee: CallAttendee.fromJson(Map<String, dynamic>.from(json['attendee'] as Map)),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'contactId': contactId,
        'participantId': participantId,
        'participantToken': participantToken,
        'callType': callType.wireName,
        'meeting': meeting.toJson(),
        'attendee': attendee.toJson(),
      };
}
