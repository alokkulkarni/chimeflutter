/**
 * Persistence for simulated-outbound call records. Backed by DynamoDB (PK `callId`, TTL attribute
 * `ttl`); handlers depend on the {@link OutboundCallStore} port so they are testable with fakes.
 *
 * Status transitions use a conditional update (`status = ringing`) so a race between answer,
 * decline and the ring-timeout sweeper resolves to exactly one winner.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { OutboundCallRecord, OutboundCallStatus } from '../domain/outbound';

export interface OutboundCallStore {
  get(callId: string): Promise<OutboundCallRecord | undefined>;
  put(record: OutboundCallRecord): Promise<void>;
  /**
   * Transitions a still-`ringing` record to `next`. Returns true when this caller won the
   * transition, false when the record was already past `ringing` (or missing).
   */
  transitionFromRinging(
    callId: string,
    next: OutboundCallStatus,
    timestamps: { answeredAt?: number; endedAt?: number },
  ): Promise<boolean>;
  /** All records still `ringing` whose expiresAt is in the past (sweeper input). */
  listExpiredRinging(nowMs: number): Promise<OutboundCallRecord[]>;
}

export function createOutboundCallStore(
  doc: DynamoDBDocumentClient,
  tableName: string,
): OutboundCallStore {
  return {
    async get(callId: string): Promise<OutboundCallRecord | undefined> {
      const result = await doc.send(new GetCommand({ TableName: tableName, Key: { callId } }));
      return result.Item as OutboundCallRecord | undefined;
    },

    async put(record: OutboundCallRecord): Promise<void> {
      await doc.send(new PutCommand({ TableName: tableName, Item: record }));
    },

    async transitionFromRinging(
      callId: string,
      next: OutboundCallStatus,
      timestamps: { answeredAt?: number; endedAt?: number },
    ): Promise<boolean> {
      const names: Record<string, string> = { '#status': 'status' };
      const values: Record<string, unknown> = { ':next': next, ':ringing': 'ringing' };
      let update = 'SET #status = :next';
      if (timestamps.answeredAt !== undefined) {
        update += ', answeredAt = :answeredAt';
        values[':answeredAt'] = timestamps.answeredAt;
      }
      if (timestamps.endedAt !== undefined) {
        update += ', endedAt = :endedAt';
        values[':endedAt'] = timestamps.endedAt;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { callId },
            UpdateExpression: update,
            ConditionExpression: '#status = :ringing',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async listExpiredRinging(nowMs: number): Promise<OutboundCallRecord[]> {
      // The table only holds ~a day of call attempts (TTL cleanup), so a filtered Scan is fine.
      const out: OutboundCallRecord[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const result = await doc.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: '#status = :ringing AND expiresAt < :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':ringing': 'ringing', ':now': nowMs },
            ExclusiveStartKey: startKey,
          }),
        );
        out.push(...((result.Items ?? []) as OutboundCallRecord[]));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return out;
    },
  };
}
