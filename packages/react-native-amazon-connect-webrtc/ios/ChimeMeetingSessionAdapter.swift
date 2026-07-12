import AmazonChimeSDK
import Foundation

/// Adapts the backend `CallSession` map (as sent by the JS controller) into a Chime
/// `MeetingSessionConfiguration`.
///
/// This is the load-bearing transform and the one piece worth unit testing on the native side. It
/// mirrors AWS's official `amazon-connect-in-app-calling-examples` iOS sample:
///  1. read `meeting`/`attendee` (the backend already unwrapped Connect's `ConnectionData`),
///  2. build via the DIRECT initializer (`MeetingSessionCredentials` + `MeetingSessionURLs`),
///  3. synthesize `externalUserId = ""` — Connect's Attendee has no ExternalUserId.
enum ChimeAdapterError: Error, Equatable {
    case missingField(String)
}

struct ChimeMeetingSessionAdapter {
    static func makeConfiguration(from session: [String: Any]) throws -> MeetingSessionConfiguration {
        guard let meeting = session["meeting"] as? [String: Any] else {
            throw ChimeAdapterError.missingField("meeting")
        }
        guard let meetingId = meeting["meetingId"] as? String, !meetingId.isEmpty else {
            throw ChimeAdapterError.missingField("meeting.meetingId")
        }
        guard let placement = meeting["mediaPlacement"] as? [String: Any] else {
            throw ChimeAdapterError.missingField("meeting.mediaPlacement")
        }
        guard let attendee = session["attendee"] as? [String: Any] else {
            throw ChimeAdapterError.missingField("attendee")
        }
        guard let attendeeId = attendee["attendeeId"] as? String, !attendeeId.isEmpty else {
            throw ChimeAdapterError.missingField("attendee.attendeeId")
        }
        guard let joinToken = attendee["joinToken"] as? String, !joinToken.isEmpty else {
            throw ChimeAdapterError.missingField("attendee.joinToken")
        }
        guard let audioHostUrl = placement["audioHostUrl"] as? String, !audioHostUrl.isEmpty else {
            throw ChimeAdapterError.missingField("mediaPlacement.audioHostUrl")
        }
        guard let signalingUrl = placement["signalingUrl"] as? String, !signalingUrl.isEmpty else {
            throw ChimeAdapterError.missingField("mediaPlacement.signalingUrl")
        }

        // Optional URLs — default sensibly when Connect omits them.
        let audioFallbackUrl = (placement["audioFallbackUrl"] as? String) ?? audioHostUrl
        let turnControlUrl = (placement["turnControlUrl"] as? String) ?? ""
        let ingestionUrl = placement["eventIngestionUrl"] as? String

        let credentials = MeetingSessionCredentials(
            attendeeId: attendeeId,
            externalUserId: "", // Connect provides none — matches the AWS iOS sample.
            joinToken: joinToken
        )
        let urls = MeetingSessionURLs(
            audioFallbackUrl: audioFallbackUrl,
            audioHostUrl: audioHostUrl,
            turnControlUrl: turnControlUrl,
            signalingUrl: signalingUrl,
            urlRewriter: URLRewriterUtils.defaultUrlRewriter,
            ingestionUrl: ingestionUrl
        )
        return MeetingSessionConfiguration(
            meetingId: meetingId,
            externalMeetingId: nil,
            credentials: credentials,
            urls: urls,
            urlRewriter: URLRewriterUtils.defaultUrlRewriter
        )
    }
}
