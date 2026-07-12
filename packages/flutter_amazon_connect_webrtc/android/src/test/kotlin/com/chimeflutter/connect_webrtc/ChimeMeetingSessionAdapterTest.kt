package com.chimeflutter.connect_webrtc

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure unit tests for the `CallSession → MeetingSessionConfiguration` adapter. No Android
 * dependencies (Chime session classes are plain data classes), so this runs as a plain JUnit test.
 */
class ChimeMeetingSessionAdapterTest {

    private fun fullSession(): Map<String, Any?> = mapOf(
        "meeting" to mapOf(
            "meetingId" to "m-1",
            "mediaRegion" to "eu-west-2",
            "mediaPlacement" to mapOf(
                "audioHostUrl" to "https://audio",
                "audioFallbackUrl" to "https://audiofb",
                "signalingUrl" to "wss://signal",
                "turnControlUrl" to "https://turn",
                "eventIngestionUrl" to "https://ingest",
            ),
        ),
        "attendee" to mapOf("attendeeId" to "a-1", "joinToken" to "jt-1"),
    )

    @Test
    fun buildsConfigurationWithSyntheticExternalUserId() {
        val config = ChimeMeetingSessionAdapter.makeConfiguration(fullSession())
        assertEquals("m-1", config.meetingId)
        assertEquals("a-1", config.credentials.attendeeId)
        assertEquals("jt-1", config.credentials.joinToken)
        // The crux: Connect provides no ExternalUserId; we synthesize "".
        assertEquals("", config.credentials.externalUserId)
        assertEquals("https://audio", config.urls.audioHostURL)
        assertEquals("wss://signal", config.urls.signalingURL)
    }

    @Test
    fun defaultsOptionalUrls() {
        val session = mapOf(
            "meeting" to mapOf(
                "meetingId" to "m",
                "mediaPlacement" to mapOf("audioHostUrl" to "https://a", "signalingUrl" to "wss://s"),
            ),
            "attendee" to mapOf("attendeeId" to "a", "joinToken" to "j"),
        )
        val config = ChimeMeetingSessionAdapter.makeConfiguration(session)
        // audioFallbackURL defaults to audioHostUrl when Connect omits it.
        assertEquals("https://a", config.urls.audioFallbackURL)
    }

    @Test(expected = ChimeMeetingSessionAdapter.MissingFieldException::class)
    fun throwsOnMissingAttendee() {
        ChimeMeetingSessionAdapter.makeConfiguration(
            mapOf(
                "meeting" to mapOf(
                    "meetingId" to "m",
                    "mediaPlacement" to mapOf("audioHostUrl" to "a", "signalingUrl" to "s"),
                ),
            ),
        )
    }

    @Test(expected = ChimeMeetingSessionAdapter.MissingFieldException::class)
    fun throwsOnMissingSignalingUrl() {
        ChimeMeetingSessionAdapter.makeConfiguration(
            mapOf(
                "meeting" to mapOf("meetingId" to "m", "mediaPlacement" to mapOf("audioHostUrl" to "a")),
                "attendee" to mapOf("attendeeId" to "a", "joinToken" to "j"),
            ),
        )
    }
}
