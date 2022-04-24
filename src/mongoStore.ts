import { Storage, StoreItems } from 'botbuilder-core';
import { ObjectId, MongoClient, Collection, MongoClientOptions, AnyBulkWriteOperation, Db } from 'mongodb';
import { RedisClientType, createClient, RedisClientOptions } from '@node-redis/client';

export interface MongoStoreOptions {
  database?: string;
  collection?: string;
  mongo?: MongoClientOptions;
  redis?: RedisClientOptions;
  cacheExpiration?: number;
  disableWriteConcern?: boolean;
}

interface StorageConnectResponse {
  mongo: 0 | 1;
  redis?: 0 | 1;
}

interface IPingResponse extends StorageConnectResponse {
  ok: 0 | 1;
}

interface MongoStoreDocument extends StoreItems {
  _id: string;
  state: string;
  date: Date;
  etag: string;
}

export class MongoStore implements Storage {
  private uri: string;

  private dbName: string;

  private colName: string;

  private key: string;

  private isCacheEnabled: boolean;

  private options: MongoStoreOptions | undefined;

  private mClient: MongoClient;

  private rClient!: RedisClientType;

  private cacheExpiration: number;

  private disableWriteConcern: boolean;

  public static readonly NO_URL_ERROR: Error = new Error('MongoStore.uri is required.');

  static readonly DEFAULT_DATABASE_NAME = 'botstorage';

  static readonly DEFAULT_COLLECTION_NAME = 'conversations';

  static readonly DEFAULT_DOCUMENT_KEY = '_id';

  static readonly DEFAULT_CACHE_EXPIRATION_TIME = 1209600;

  constructor(uri: string, options: MongoStoreOptions = {}) {
    // throw error if configs are missing
    if (!uri || uri.trim() === '') throw MongoStore.NO_URL_ERROR;

    // Default assignments
    this.options = options;
    this.uri = uri;
    this.dbName = MongoStore.DEFAULT_DATABASE_NAME;
    this.colName = MongoStore.DEFAULT_COLLECTION_NAME;
    this.key = MongoStore.DEFAULT_DOCUMENT_KEY;
    this.isCacheEnabled = false;
    this.cacheExpiration = options.cacheExpiration || MongoStore.DEFAULT_CACHE_EXPIRATION_TIME;
    this.disableWriteConcern = options.disableWriteConcern || false;

    // Options
    const { database, collection, redis: redisOptions, mongo: mongoOptions } = options;
    if (database && database.trim()) {
      this.dbName = database.trim();
    }
    if (collection && collection.trim()) {
      this.colName = collection.trim();
    }
    this.mClient = new MongoClient(this.uri, mongoOptions);
    if (redisOptions) {
      this.isCacheEnabled = true;
      this.rClient = createClient(redisOptions);
    }
  }

  get database(): Db {
    return this.mClient.db(this.dbName);
  }

  get storage(): Collection<MongoStoreDocument> {
    return this.mClient.db(this.dbName).collection(this.colName);
  }

  get cache(): RedisClientType {
    return this.rClient;
  }

  public async connect(): Promise<StorageConnectResponse> {
    const response: StorageConnectResponse = { mongo: 0 };
    const connections: Promise<unknown>[] = [
      this.mClient.connect().then(() => {
        response.mongo = 1;
      }),
    ];
    if (this.isCacheEnabled && this.rClient) {
      response.redis = 0;
      connections.push(
        this.rClient.connect().then(() => {
          response.redis = 1;
        })
      );
    }
    await Promise.all(connections);
    return response;
  }

  // read state keys from database
  public async read(stateKeys: string[]): Promise<StoreItems> {
    if (!stateKeys || stateKeys.length === 0) {
      return {};
    }
    const states = {};
    if (this.isCacheEnabled) {
      const { cached, missing } = await this.readRedis(stateKeys);
      Object.assign(states, cached);
      if (missing.length > 0) {
        const missingStates = await this.readMongo(missing);
        Object.assign(states, missingStates);
      }
    } else {
      const mongoStates = await this.readMongo(stateKeys);
      Object.assign(states, mongoStates);
    }
    return states;
  }

  // write updates to database
  public async write(changes: StoreItems): Promise<void> {
    if (!changes || Object.keys(changes).length === 0) {
      return;
    }
    const writeOperations: Promise<unknown>[] = [this.writeMongo(changes)];
    if (this.isCacheEnabled) {
      writeOperations.push(this.writeRedis(changes));
    }
    await Promise.all(writeOperations);
  }

  // delete state key data from database
  public async delete(keys: string[]): Promise<void> {
    if (!keys || keys.length === 0) {
      return;
    }
    await Promise.all([this.deleteRedis(keys), this.deleteMongo(keys)]);
  }

  private async readRedis(stateKeys: string[]): Promise<{ cached: Record<string, unknown>; missing: string[] }> {
    const missing: string[] = [];
    const cachedSates = await Promise.all(
      stateKeys.map(async (key) => {
        const value = await this.cache.get(key);
        return {
          key,
          value,
        };
      })
    );
    const cached = cachedSates.reduce((accum: Record<string, unknown>, { key, value }) => {
      if (value) {
        accum[key] = JSON.parse(value);
      } else {
        missing.push(key);
      }
      return accum;
    }, {});
    return {
      cached,
      missing,
    };
  }

  private async readMongo(stateKeys: string[]): Promise<Record<string, unknown>> {
    const docs = this.storage.find({
      [this.key]: { $in: stateKeys },
    });
    return (await docs.toArray()).reduce((accum: Record<string, unknown>, item) => {
      accum[item[this.key]] = JSON.parse(item.state);
      return accum;
    }, {});
  }

  private async writeRedis(changes: StoreItems): Promise<void> {
    const writeOperations = Object.keys(changes).map(async (key) => {
      const state = changes[key];
      await this.cache.set(key, JSON.stringify(state), {
        EX: this.cacheExpiration,
      });
    });
    await Promise.all(writeOperations);
  }

  private async writeMongo(changes: StoreItems): Promise<void> {
    const operations: AnyBulkWriteOperation<MongoStoreDocument>[] = [];
    Object.keys(changes).forEach((key) => {
      const state = changes[key];
      state.eTag = new ObjectId().toHexString();
      operations.push({
        updateOne: {
          filter: { [this.key]: key },
          update: {
            $set: {
              state: JSON.stringify(state),
              date: new Date(),
              etag: state.eTag,
            },
          },
          upsert: true,
        },
      });
    });
    await this.storage.bulkWrite(operations, {
      writeConcern: !this.disableWriteConcern ? { w: 0 } : { w: 'majority' },
    });
  }

  private async deleteRedis(stateKeys: string[]): Promise<void> {
    const deleteOperations = stateKeys.map(async (key) => this.cache.del(key));
    await Promise.all(deleteOperations);
  }

  private async deleteMongo(stateKeys: string[]): Promise<void> {
    await this.storage.deleteMany(
      { [this.key]: { $in: stateKeys } },
      { writeConcern: !this.disableWriteConcern ? { w: 0 } : { w: 'majority' } }
    );
  }

  // should always return result
  public async health(): Promise<IPingResponse> {
    const ping: IPingResponse = { ok: 0, mongo: 0 };
    const mongoResponse = await this.mClient.db(this.dbName).admin().command({ ping: 1 });
    this.rClient.ping();
    if (mongoResponse && mongoResponse.ok) {
      ping.mongo = 1;
    }

    if (this.isCacheEnabled) {
      ping.redis = 0;
      const redisResponse = await this.rClient.ping();
      if (redisResponse) {
        ping.redis = 1;
      }
    }

    ping.ok = ping.mongo;
    if (this.isCacheEnabled && !ping.redis) {
      ping.ok = 0;
    }
    return ping;
  }
}

export default MongoStore;
