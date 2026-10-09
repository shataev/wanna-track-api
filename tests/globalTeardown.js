module.exports = async () => {
    await globalThis.__MONGOD__.stop();
};
