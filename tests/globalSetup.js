const { MongoMemoryServer } = require('mongodb-memory-server-core');

module.exports = async () => {
    const mongod = await MongoMemoryServer.create();

    globalThis.__MONGOD__ = mongod;
    process.env.TEST_MONGO_URL = mongod.getUri();
};
