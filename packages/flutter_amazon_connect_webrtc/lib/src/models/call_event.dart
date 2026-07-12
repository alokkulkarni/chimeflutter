import 'package:meta/meta.dart';

/// Discrete events emitted during a call (distinct from lifecycle [CallState] changes).
///
/// Parsed from the native event channel by [CallEvent.fromMap], which dispatches on the `type`
/// discriminator defined in `specs/003-api-contracts.md §B.2`.
@immutable
sealed class CallEvent {
  const CallEvent();

  /// Builds a typed event from a native event-channel map. Returns `null` for `stateChanged`
  /// (handled as a [CallState]) or any unrecognised type.
  static CallEvent? fromMap(Map<String, dynamic> map) {
    final type = map['type'] as String?;
    switch (type) {
      case 'muteChanged':
        return MuteChanged(muted: map['muted'] as bool);
      case 'participantJoined':
        return RemoteParticipantJoined(
          attendeeId: map['attendeeId'] as String,
          externalUserId: map['externalUserId'] as String?,
        );
      case 'participantLeft':
        return RemoteParticipantLeft(attendeeId: map['attendeeId'] as String);
      case 'localVideoAvailable':
        return LocalVideoTileAdded(tileId: (map['tileId'] as num).toInt());
      case 'remoteVideoAvailable':
        return RemoteVideoTileAdded(
          tileId: (map['tileId'] as num).toInt(),
          attendeeId: map['attendeeId'] as String,
        );
      case 'videoTileRemoved':
        return VideoTileRemoved(tileId: (map['tileId'] as num).toInt());
      case 'audioRouteChanged':
        return AudioRouteChanged(route: map['route'] as String);
      case 'networkQualityChanged':
        return NetworkQualityChanged(
          quality: map['quality'] as String,
          attendeeId: map['attendeeId'] as String?,
        );
      case 'error':
        return CallErrorEvent(
          code: map['code'] as String,
          message: (map['message'] as String?) ?? '',
          fatal: (map['fatal'] as bool?) ?? false,
        );
      default:
        return null;
    }
  }
}

class MuteChanged extends CallEvent {
  const MuteChanged({required this.muted});
  final bool muted;
}

class RemoteParticipantJoined extends CallEvent {
  const RemoteParticipantJoined({required this.attendeeId, this.externalUserId});
  final String attendeeId;
  final String? externalUserId;
}

class RemoteParticipantLeft extends CallEvent {
  const RemoteParticipantLeft({required this.attendeeId});
  final String attendeeId;
}

class LocalVideoTileAdded extends CallEvent {
  const LocalVideoTileAdded({required this.tileId});
  final int tileId;
}

class RemoteVideoTileAdded extends CallEvent {
  const RemoteVideoTileAdded({required this.tileId, required this.attendeeId});
  final int tileId;
  final String attendeeId;
}

class VideoTileRemoved extends CallEvent {
  const VideoTileRemoved({required this.tileId});
  final int tileId;
}

class AudioRouteChanged extends CallEvent {
  const AudioRouteChanged({required this.route});
  final String route;
}

class NetworkQualityChanged extends CallEvent {
  const NetworkQualityChanged({required this.quality, this.attendeeId});
  final String quality;
  final String? attendeeId;
}

class CallErrorEvent extends CallEvent {
  const CallErrorEvent({required this.code, required this.message, this.fatal = false});
  final String code;
  final String message;
  final bool fatal;
}
