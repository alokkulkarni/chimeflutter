# 004 — Sequence Diagrams

**Related:** [002-architecture](./002-architecture.md) · [003-api-contracts](./003-api-contracts.md)

## 1. Start an audio (VoIP) call, routed by context

```mermaid
sequenceDiagram
    autonumber
    participant U as Customer
    participant Host as Native host app
    participant Dart as Flutter controller
    participant API as API GW + Lambda
    participant Auth as JWT authorizer
    participant Connect as Amazon Connect
    participant Chime as Chime SDK (native)
    participant Agent as Agent

    U->>Host: tap "Call support"
    Host->>Dart: startCall(audio, context, device)
    Dart->>Dart: ensure microphone permission (FR-F6)
    Dart->>API: POST /v1/calls  (Bearer JWT, Idempotency-Key)
    API->>Auth: verify signature / iss / aud / exp
    Auth-->>API: allow + trusted claims (customerId, tier)
    API->>API: merge attributes (trusted ⟩ client ⟩ device)
    API->>Connect: StartWebRTCContact(Attributes, ContactFlowId, InstanceId)
    Connect-->>API: ConnectionData(Meeting, Attendee), ContactId, ParticipantToken
    API-->>Dart: 201 CallSession (camelCase, no InstanceId)
    Dart->>Chime: join(meeting, attendee)   %% externalUserId=""
    Chime->>Connect: WebRTC audio (VoIP) media
    Connect->>Agent: route to queue by $.Attributes.issueType / tier
    Chime-->>Dart: stateChanged: connected
    Agent-->>U: two-way audio
```

## 2. Start a video (WebRTC) call

```mermaid
sequenceDiagram
    autonumber
    participant Dart as Flutter controller
    participant API as API GW + Lambda
    participant Connect as Amazon Connect
    participant Chime as Chime SDK (native)

    Dart->>Dart: ensure mic + camera permission
    Dart->>API: POST /v1/calls { callType: "video" }
    API->>Connect: StartWebRTCContact(AllowedCapabilities.Customer/Agent.Video = SEND)
    Connect-->>API: ConnectionData(...)
    API-->>Dart: 201 CallSession(callType=video)
    Dart->>Chime: join(...)
    Chime-->>Dart: stateChanged: connected
    Dart->>Chime: enableLocalVideo()
    Chime-->>Dart: localVideoAvailable(tileId)
    Note over Dart: host renders ConnectVideoView(tileId)
    Chime-->>Dart: remoteVideoAvailable(tileId) when agent shares video
```

## 3. Idempotent retry on throttling

```mermaid
sequenceDiagram
    autonumber
    participant Dart as BackendClient
    participant API as API GW + Lambda
    participant Connect as Amazon Connect

    Dart->>API: POST /v1/calls (Idempotency-Key: K)
    API->>Connect: StartWebRTCContact(ClientToken: K)
    Connect-->>API: ThrottlingException
    API-->>Dart: 429 RATE_LIMITED
    Note over Dart: backoff, SAME key K
    Dart->>API: POST /v1/calls (Idempotency-Key: K)
    API->>Connect: StartWebRTCContact(ClientToken: K)
    Connect-->>API: ConnectionData(...) (same contact, not a duplicate)
    API-->>Dart: 201 CallSession
```

## 4. End a call

```mermaid
sequenceDiagram
    autonumber
    participant U as Customer
    participant Dart as Flutter controller
    participant Chime as Chime SDK (native)
    participant API as API GW + Lambda
    participant Connect as Amazon Connect

    U->>Dart: endCall()
    Dart->>Chime: leave()  (stop media, release audio session/service)
    Chime-->>Dart: stateChanged: disconnected
    Dart->>API: DELETE /v1/calls/{contactId}  (best effort)
    API->>Connect: StopContact(ContactId, InstanceId)
    Connect-->>API: ok
    API-->>Dart: 204
```

## 5. Failure paths

```mermaid
sequenceDiagram
    autonumber
    participant Dart as Flutter controller
    participant API as API GW + Lambda

    alt microphone denied
        Dart->>Dart: permission denied → state=failed (no backend call)
    else backend/Connect throttled after retries
        Dart->>API: POST /v1/calls
        API-->>Dart: 429 → RateLimitedException → state=failed
    else media drops mid-call
        Note over Dart: native emits reconnecting → connected | failed
    end
```
