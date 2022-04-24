![logo](https://raw.githubusercontent.com/pvkas/botbuilder-mongo-storage/main/img/logo.png)

## Bot Framework MongoDB Storage + Cache (Redis)

## Table of Contents

- Quick start
  - [Installation](#installation)
  - [Usage](#usage)
  - [Options](#options)
  - [Advanced Usage](#advanced-usage)
- Description
  - Cache Usage
- FAQ
  - Why ?

## Installation:

```
npm install botbuilder-mongo-storage
```

## Usage

#### Normal

```javascript
// Options
const options = {
  database: 'foobar',
  collection: 'conversations',
};

async () => {
  // storage
  const storage = new MongoStore('mongodb://localhost:27017/', options);
  await storage.connect();
  const conversationState = new ConversationState(storage);
};
```

#### Redis Cache ([redis options](https://redis.js.org/documentation/client/interfaces/lib_client.RedisClientOptions.html))

```javascript
// Options
const options = {
  database: 'foobar',
  collection: 'conversations',
  redis: {
    url: 'redis://alice:foobared@localhost:6380',
  },
};

async () => {
  // storage
  const storage = new MongoStore('mongodb://localhost:27017/', options);
  await storage.connect();
  const conversationState = new ConversationState(storage);
};
```

## Options

| Parameter           | Type                                                         | Defaut value                              | Description                                                  |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------ |
| database            | String                                                       | `bot-storage`                             | database name in mongodb                                     |
| collection          | String                                                       | `conversations`                           | collection name to store states                              |
| mongo               | [MongoOptions](https://docs.mongodb.com/drivers/node/current/fundamentals/connection/#connection-options) | `-`                                       | optional mongo connection options                            |
| redis               | [RedisOptions](https://redis.js.org/documentation/client/interfaces/lib_client.RedisClientOptions.html) | `-`                                       | optional cache redis options                                 |
| cacheExpiration     | Number                                                       | `1209600` - 14 days                       | optonal TTL in seconds for redis cached state <br />(14 days is default Microsoft direcline conversation inactivity expiration time) |
| disableWriteConcern | Boolean                                                      | `false`(w/ redis)<br />`true` (w/o redis) | optional only when using redis, mongodb queries will be executed with `writeConcern: { w: 0 }` for betternperfomance.<br /> [more details](https://docs.mongodb.com/manual/reference/write-concern/#w-option) |

## Advanced Usage

```javascript
// Options
const storageOptions = {
  database: 'bot',
  collection: 'conversations',
  redis: {
    url: 'redis://alice:foobared@localhost:6380',
  },
  mongo: {
    tls: true,
  },
  cacheExpiration: 604800, // 7 days
};

async () => {
  // storage
  const storage = new MongoStore('mongodb://localhost:27017/', storageOptions);
  await storage.connect();
  const conversationState = new ConversationState(storage);

  server.get('/health', (req, res) => {
    const storageHealth = await storage.health(); // always resolves promise - no need to catch error
    // const storageHealth = {
    //   ok: 1,
    //   mongo: 1,
    //   redis: 1, // only if redis is enabled
    // };
    res.status(200);
    res.send({
      ok: 1,
      storage: storageHealth,
    });
  });
};
```
