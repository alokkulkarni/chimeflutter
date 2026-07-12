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
