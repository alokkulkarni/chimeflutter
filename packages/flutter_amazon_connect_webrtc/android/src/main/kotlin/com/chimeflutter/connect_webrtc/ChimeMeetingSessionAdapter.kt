package com.chimeflutter.connect_webrtc

import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionConfiguration
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionCredentials
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionURLs
import com.amazonaws.services.chime.sdk.meetings.session.defaultUrlRewriter

/**
 * Adapts the backend `CallSession` map (sent by Dart over the method channel) into a Chime
 * [MeetingSessionConfiguration].
 *
 * The load-bearing native transform and the one piece unit tested (pure — no Android deps). Mirrors
 * AWS's official Android sample: read `meeting`/`attendee` (Dart already unwrapped Connect's
 * `ConnectionData`), build via the direct constructor, and synthesize `externalUserId = ""` because
 * Connect's Attendee carries no ExternalUserId.
 */
object ChimeMeetingSessionAdapter {

    class MissingFieldException(field: String) :
        IllegalArgumentException("CallSession missing required field: $field")

    @Suppress("UNCHECKED_CAST")
    fun makeConfiguration(session: Map<String, Any?>): MeetingSessionConfiguration {
        val meeting = session["meeting"] as? Map<String, Any?>
            ?: throw MissingFieldException("meeting")
        val meetingId = (meeting["meetingId"] as? String)?.takeIf { it.isNotEmpty() }
            ?: throw MissingFieldException("meeting.meetingId")
        val placement = meeting["mediaPlacement"] as? Map<String, Any?>
            ?: throw MissingFieldException("meeting.mediaPlacement")
        val attendee = session["attendee"] as? Map<String, Any?>
            ?: throw MissingFieldException("attendee")
        val attendeeId = (attendee["attendeeId"] as? String)?.takeIf { it.isNotEmpty() }
            ?: throw MissingFieldException("attendee.attendeeId")
        val joinToken = (attendee["joinToken"] as? String)?.takeIf { it.isNotEmpty() }
            ?: throw MissingFieldException("attendee.joinToken")
        val audioHostUrl = (placement["audioHostUrl"] as? String)?.takeIf { it.isNotEmpty() }
            ?: throw MissingFieldException("mediaPlacement.audioHostUrl")
        val signalingUrl = (placement["signalingUrl"] as? String)?.takeIf { it.isNotEmpty() }
            ?: throw MissingFieldException("mediaPlacement.signalingUrl")

        val audioFallbackUrl = placement["audioFallbackUrl"] as? String ?: audioHostUrl
        val turnControlUrl = placement["turnControlUrl"] as? String ?: ""
        val ingestionUrl = placement["eventIngestionUrl"] as? String ?: ""

        val credentials = MeetingSessionCredentials(
            attendeeId = attendeeId,
            externalUserId = "", // Connect provides none — matches the AWS Android sample.
            joinToken = joinToken,
        )
        val urls = MeetingSessionURLs(
            _audioFallbackURL = audioFallbackUrl,
            _audioHostURL = audioHostUrl,
            _turnControlURL = turnControlUrl,
            _signalingURL = signalingUrl,
            urlRewriter = ::defaultUrlRewriter,
            _ingestionURL = ingestionUrl,
        )
        return MeetingSessionConfiguration(
            meetingId = meetingId,
            externalMeetingId = null,
            credentials = credentials,
            urls = urls,
        )
    }
}
