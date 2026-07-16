/**
 * Device push-token registry — one registered device per customerId (upsert). Backed by DynamoDB;
 * handlers depend on the {@link DeviceStore} port so they are testable with in-memory fakes.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DeviceRecord } from '../domain/outbound';

export interface DeviceStore {
  get(customerId: string): Promise<DeviceRecord | undefined>;
  put(record: DeviceRecord): Promise<void>;
}

export function createDeviceStore(doc: DynamoDBDocumentClient, tableName: string): DeviceStore {
  return {
    async get(customerId: string): Promise<DeviceRecord | undefined> {
      const result = await doc.send(new GetCommand({ TableName: tableName, Key: { customerId } }));
      return result.Item as DeviceRecord | undefined;
    },
    async put(record: DeviceRecord): Promise<void> {
      await doc.send(new PutCommand({ TableName: tableName, Item: record }));
    },
  };
}

/** Shared, lazily-created DocumentClient (Lambda connection-reuse best practice). */
let sharedDoc: DynamoDBDocumentClient | undefined;
export function getDocumentClient(region: string): DynamoDBDocumentClient {
  if (!sharedDoc) {
    sharedDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 3 }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return sharedDoc;
}
