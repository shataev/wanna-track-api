const mongoose = require('mongoose');

// One database per test file, emptied after every test
beforeAll(async () => {
    const dbName = `test-${process.env.JEST_WORKER_ID}-${Date.now()}`;

    await mongoose.connect(process.env.TEST_MONGO_URL, { dbName });
});

afterEach(async () => {
    const collections = await mongoose.connection.db.collections();

    await Promise.all(collections.map(collection => collection.deleteMany({})));

    delete process.env.AUTH_ENFORCE;
    delete process.env.ADMIN_SECRET;
    delete process.env.ACCESS_TOKEN_TTL_SECONDS;
});

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
});
