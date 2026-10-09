const router = require('express').Router();
const Category = require('../models/Category');
const { authenticate, authenticateUserOrBot } = require('../middlewares/authenticate');

// Get all user's categories
router.get('/category', authenticateUserOrBot, async (req, res) => {
    try {
        const userId = req.user.id;

        let categories = await Category.find({
            user:  [null, userId],
        })

        categories = categories.map(category => {
            const {name, icon, _id: value} = category;

            return {
                name, icon, value
            }
        })

        res
            .status(201)
            .json(categories);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }

})


// Add new category
// Always the caller's own: a category with user null is global and shows up for every user
router.post('/category', authenticate, async (req, res) => {
    const {
        name,
        icon,
    } = req.body;

    const newCategory = new Category({
        name,
        icon,
        user: req.user.id
    });

    try {
        const category = await newCategory.save();

        res
            .status(201)
            .json(category);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

module.exports = router;
