import AmazonChimeSDK
import XCTest
@testable import flutter_amazon_connect_webrtc

/// Unit tests for the load-bearing `CallSession → MeetingSessionConfiguration` adapter. Runs in CI
/// with the AmazonChimeSDK pod installed (see docs/CI.md).
final class ChimeMeetingSessionAdapterTests: XCTestCase {
    private func fullSession() -> [String: Any] {
        [
            "meeting": [
                "meetingId": "m-1",
                "mediaRegion": "eu-west-2",
                "mediaPlacement": [
                    "audioHostUrl": "https://audio",
                    "audioFallbackUrl": "https://audiofb",
                    "signalingUrl": "wss://signal",
                    "turnControlUrl": "https://turn",
                    "eventIngestionUrl": "https://ingest",
                ],
            ],
            "attendee": ["attendeeId": "a-1", "joinToken": "jt-1"],
        ]
    }

    func testBuildsConfigurationWithSyntheticExternalUserId() throws {
        let config = try ChimeMeetingSessionAdapter.makeConfiguration(from: fullSession())
        XCTAssertEqual(config.meetingId, "m-1")
        XCTAssertEqual(config.credentials.attendeeId, "a-1")
        XCTAssertEqual(config.credentials.joinToken, "jt-1")
        // The crux: Connect provides no ExternalUserId; we synthesize "".
        XCTAssertEqual(config.credentials.externalUserId, "")
        XCTAssertEqual(config.urls.audioHostUrl, "https://audio")
        XCTAssertEqual(config.urls.signalingUrl, "wss://signal")
    }

    func testDefaultsOptionalUrls() throws {
        let minimal: [String: Any] = [
            "meeting": [
                "meetingId": "m",
                "mediaPlacement": ["audioHostUrl": "https://a", "signalingUrl": "wss://s"],
            ],
            "attendee": ["attendeeId": "a", "joinToken": "j"],
        ]
        let config = try ChimeMeetingSessionAdapter.makeConfiguration(from: minimal)
        // audioFallbackUrl defaults to audioHostUrl when Connect omits it.
        XCTAssertEqual(config.urls.audioFallbackUrl, "https://a")
    }

    func testThrowsOnMissingAttendee() {
        let session: [String: Any] = [
            "meeting": ["meetingId": "m", "mediaPlacement": ["audioHostUrl": "a", "signalingUrl": "s"]],
        ]
        XCTAssertThrowsError(try ChimeMeetingSessionAdapter.makeConfiguration(from: session)) { error in
            XCTAssertEqual(error as? ChimeAdapterError, .missingField("attendee"))
        }
    }

    func testThrowsOnMissingMediaUrls() {
        let session: [String: Any] = [
            "meeting": ["meetingId": "m", "mediaPlacement": ["audioHostUrl": "a"]], // no signalingUrl
            "attendee": ["attendeeId": "a", "joinToken": "j"],
        ]
        XCTAssertThrowsError(try ChimeMeetingSessionAdapter.makeConfiguration(from: session)) { error in
            XCTAssertEqual(error as? ChimeAdapterError, .missingField("mediaPlacement.signalingUrl"))
        }
    }
}
