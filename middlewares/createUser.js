const CryptoJS = require("crypto-js");
const User = require("../models/User");
const {toAuthUser} = require("../utils/auth.utils");

/**
 * Создает в базе нового юзера, предварительно захешировав его пароль,
 * пишет его в req и передает управление дальше
 * TODO: валидировать входные параметры
 * @type {{createUser(*, *, *): Promise<void>}}
 */
module.exports = {
    async createUser(req, res, next) {
        const {
            username,
            email,
            password: rawPassword
        } = req.body;

        const password = CryptoJS.AES.encrypt(rawPassword, process.env.SECRET_KEY).toString();

        const newUser = new User({
            username,
            email,
            password
        });

        try {
            const user = await newUser.save();

            req.user = toAuthUser(user);

            next();
        } catch (error) {
            res
                .status(500)
                .json(error);
        }
    }
}
