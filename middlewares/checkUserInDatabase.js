const User = require("../models/User");
const CryptoJS = require("crypto-js");
const jwt = require("jsonwebtoken");
const {toAuthUser} = require("../utils/auth.utils");

/**
 * Проверяет, есть ли пользователь в базе, сравнивает переданный и сохраненный пароль
 * и, в случае успеха, передает данные пользователя в req.user дальше
 * @type {{checkUserInDatabase(*, *, *): Promise<*|undefined>}}
 */
module.exports = {
    async checkUserInDatabase(req, res, next) {
        const {
            email,
            password: passwordFromClient
        } = req.body;


        try {
            const user = await User.findOne({
                email,
            });

            if (!user) {
                return res.status(401).json('Wrong email or password');
            }

            const bytes  = CryptoJS.AES.decrypt(user.password, process.env.SECRET_KEY);
            const passwordFromDb = bytes.toString(CryptoJS.enc.Utf8);

            if (passwordFromClient !== passwordFromDb) {
                return res.status(401).json('Wrong email or password');
            }

            req.user = toAuthUser(user);

            next();
        } catch (error) {
            res.status(500).json(error);
        }
    }
}
