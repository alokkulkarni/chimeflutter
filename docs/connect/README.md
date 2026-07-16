# Amazon Connect routing flow

[`chimeflutter-inapp-routing.json`](./chimeflutter-inapp-routing.json) — an importable Amazon Connect
**Flow Language** (`2019-10-30`) contact flow that routes an in-app WebRTC contact to the right queue
using the contact attributes the backend injects. Validated with the flow-builder validator (PASS).

## Routing logic

```
setRoutingAttributes (tag callHandledBy=chimeflutter-flow)
        └─▶ checkTier ($.Attributes.tier)
              ├─ "gold" ─────────────▶ setQueuePriority ─┐
              └─ (no match) ─▶ checkIssueType ($.Attributes.issueType)
                                   ├─ "billing" ▶ setQueueBilling ─┤
                                   ├─ "tech"    ▶ setQueueTechnical ┤
                                   └─ (no match/general) ▶ setQueueGeneral ┤
                                                                            ▼
                                                                    transferToQueue ─▶ disconnect
```
Every `SetWorkingQueue` error falls back to the **General** queue; a failed transfer disconnects.

## Placeholders to replace before import

| Token | Replace with |
|-------|--------------|
| `${QUEUE_ARN_Priority}`  | ARN (or name) of your **Priority** queue |
| `${QUEUE_ARN_Billing}`   | ARN of your **Billing** queue |
| `${QUEUE_ARN_Technical}` | ARN of your **Technical** queue |
| `${QUEUE_ARN_General}`   | ARN of your **General** queue (also the error fallback) |

Queue ARN format: `arn:aws:connect:<region>:<account-id>:instance/<instance-id>/queue/<queueId>`.
In the new flow designer you can also pick the queue by name after import (a yellow "unsaved
resource" warning before save is normal).

## Import steps

1. Connect console → **Routing → Flows → Create flow** → type **Contact flow (inbound)**.
2. Top-right dropdown → **Import (beta)** → select `chimeflutter-inapp-routing.json`.
3. Open each **Set working queue** block and select the real queue (or pre-substitute the ARNs).
4. **Save** → **Publish**. Copy the **ContactFlowId** (flow page → *Show additional flow information*)
   into the SAM `ContactFlowId` parameter — see [../DEPLOYMENT.md](../DEPLOYMENT.md).

## How the attributes get here

The backend `StartWebRTCContact` call sets `Attributes` from (trusted JWT claims ⟩ allow-listed client
context ⟩ device). This flow reads them as `$.Attributes.tier` / `$.Attributes.issueType`. To route on
more keys (e.g. `preferredAgentId`, `language`), add `Compare` blocks the same way.

---

# Outbound-to-agent flow (simulated outbound)

[`chimeflutter-outbound-to-agent.json`](./chimeflutter-outbound-to-agent.json) — the flow used by
**agent-initiated ("simulated outbound") calls**: `POST /calls/outbound` injects
`direction=outbound` and `targetAgentArn`, and this flow routes the contact straight into that
agent's personal queue so it is offered to them immediately (occupying their voice slot while the
customer's phone rings). Validated with the flow-builder validator (PASS). Full feature guide:
[../OUTBOUND_CALLS.md](../OUTBOUND_CALLS.md).

## Routing logic

```
setOutboundMarker (tag callHandledBy=chimeflutter-outbound-flow)
        └─▶ setAgentQueue (UpdateContactTargetQueue, AgentId = $.Attributes.targetAgentArn)
                 └─▶ transferToAgentQueue ─▶ disconnect (when the contact ends)
   errors / QueueAtCapacity ─▶ setFallbackQueue (${QUEUE_ARN_General}) ─▶ transferToFallbackQueue
```

## Placeholders to replace before import

| Token | Replace with |
|-------|--------------|
| `${QUEUE_ARN_General}` | ARN of your **General** queue (error/at-capacity fallback) |

## Import steps

1. Connect console → **Routing → Flows → Create flow** → type **Contact flow (inbound)**.
2. **Import (beta)** → select `chimeflutter-outbound-to-agent.json`.
3. Fix the fallback queue in **setFallbackQueue**, **Save** → **Publish**.
4. Copy the flow ID into the SAM `ConnectOutboundContactFlowId` parameter (or
   `CONNECT_OUTBOUND_CONTACT_FLOW_ID` for Docker).

**Alternative:** extend `chimeflutter-inapp-routing.json` instead — add a first `Compare` on
`$.Attributes.direction`: `outbound` → the set-agent-queue path; anything else → the existing
tier/issueType routing — and leave `ConnectOutboundContactFlowId` empty.

Recommended per-agent settings: routing profile includes the **Voice** channel; enable
**auto-accept calls** so the agent leg connects with zero clicks.
