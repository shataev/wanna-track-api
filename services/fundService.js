const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const Cost = require('../models/Cost');
const { getRatesObject } = require('./exchangeRateService');
const { FUND_KINDS, parseGoal, findOwnedFund, isArchived } = require('../utils/fund.utils');
const { getConversionRate, roundToCurrencyPrecision } = require('../utils/currency.utils');
const { parseObjectId } = require('../utils/id.utils');

/**
 * What a fund can be asked to do, for the REST routes and the MCP tools alike, so both follow the same rules.
 * Each function answers { fund } / { body } on success or { status, error[, code] } on a refusal.
 */

const createFund = async (user, {
    name,
    icon,
    description,
    initialBalance,
    isDefault,
    currency,
    kind = 'account',
    goal
}) => {
    if (!FUND_KINDS.includes(kind)) {
        return { status: 400, error: 'Kind must be account or savings' };
    }

    let parsedGoal = null;

    if (goal !== undefined) {
        const parsed = parseGoal(goal);

        if (parsed.error) {
            return { status: 400, error: parsed.error };
        }

        parsedGoal = parsed.value;
    }

    if (kind !== 'savings' && parsedGoal) {
        return { status: 400, error: 'Only a savings fund can have a goal' };
    }

    if (kind === 'savings' && isDefault) {
        return { status: 400, error: 'A savings fund cannot be the default' };
    }

    const fund = await new Fund({
        kind,
        goal: parsedGoal,
        name,
        icon,
        description,
        initialBalance,
        currentBalance: initialBalance,
        isDefault,
        currency,
        userId: user.id
    }).save();

    return { fund };
};

const updateFund = async (user, id, { name, description, currentBalance, icon, isDefault, currency, kind, goal }) => {
    const oldFund = await findOwnedFund(id, user.id);

    if (!oldFund) {
        return { status: 404, error: 'Fund is not found' };
    }

    if (isDefault && isArchived(oldFund)) {
        return { status: 400, error: 'Fund is archived' };
    }

    if (kind !== undefined && !FUND_KINDS.includes(kind)) {
        return { status: 400, error: 'Kind must be account or savings' };
    }

    const newKind = kind ?? oldFund.kind ?? 'account';
    const update = { name, description, currentBalance, icon, isDefault, currency };

    if (goal !== undefined) {
        const parsed = parseGoal(goal);

        if (parsed.error) {
            return { status: 400, error: parsed.error };
        }

        if (newKind !== 'savings' && parsed.value) {
            return { status: 400, error: 'Only a savings fund can have a goal' };
        }

        update.goal = parsed.value;
    }

    if (newKind === 'savings' && isDefault) {
        return { status: 400, error: 'A savings fund cannot be the default' };
    }

    if (kind !== undefined) {
        update.kind = kind;
    }

    if (newKind === 'savings') {
        // Becoming savings drops the default flag
        update.isDefault = false;
    } else if (goal === undefined) {
        // An account has no goal: turning a savings fund back into one clears it
        update.goal = null;
    }

    const fund = await Fund.findOneAndUpdate(
        { _id: oldFund._id, userId: user.id },
        update,
        { new: true }
    );

    if (!fund) {
        return { status: 404, error: 'Fund is not found' };
    }

    // Create Transaction to adjust the balance
    await new FundTransaction({
        userId: fund.userId,
        fundId: fund.id,
        type: 'adjustment',
        amount: fund.currentBalance - oldFund.currentBalance,
        description: 'Manual adjustment',
    }).save();

    return { fund, previousBalance: oldFund.currentBalance };
};

const deleteFund = async (user, id) => {
    const owned = await findOwnedFund(id, user.id);

    if (!owned) {
        return { status: 404, error: 'Fund not found' };
    }

    // Only a fund with no history can go: no cost on it and no transaction (creating a fund writes none)
    const [cost, transaction] = await Promise.all([
        Cost.exists({ fund: owned._id }),
        FundTransaction.exists({ fundId: owned._id })
    ]);

    if (cost || transaction) {
        return { status: 409, error: 'The fund has history; archive it instead', code: 'fund_has_history' };
    }

    const fund = await Fund.findOneAndDelete({ _id: owned._id, userId: user.id });

    if (!fund) {
        return { status: 404, error: 'Fund not found' };
    }

    await FundTransaction.deleteMany({ fundId: fund._id });

    return { fund };
};

// Archive / restore a fund: the money and the history stay, only the listing and the total change. Idempotent
const setFundArchived = async (user, id, archive) => {
    const fund = await findOwnedFund(id, user.id);

    if (!fund) {
        return { status: 404, error: 'Fund not found' };
    }

    // Already in the requested state: nothing to change, and an archive keeps its original date
    if (isArchived(fund) === archive) {
        return { fund };
    }

    const update = archive
        ? { $set: { archivedAt: new Date(), isDefault: false } }
        : { $set: { archivedAt: null } };

    return { fund: await Fund.findOneAndUpdate({ _id: fund._id, userId: user.id }, update, { new: true }) };
};

// Move money between two of the user's funds; the amount is in the source fund's currency
const transferFunds = async (user, { fromFundId, toFundId, amount, description }) => {
    const userId = user.id;

    if (fromFundId === toFundId) {
        return { status: 400, error: 'Funds must be different' };
    }

    const withdrawnAmount = Number(amount);

    if (!Number.isFinite(withdrawnAmount) || withdrawnAmount <= 0) {
        return { status: 400, error: 'Amount must be a positive number' };
    }

    // A malformed id is treated like someone else's fund instead of failing the cast with a 500
    const fromId = parseObjectId(fromFundId);
    const toId = parseObjectId(toFundId);

    // Find both funds and check ownership in a single query
    const funds = fromId && toId ? await Fund.find({
        _id: { $in: [fromId, toId] },
        userId
    }) : [];

    if (funds.length !== 2) {
        return { status: 404, error: 'One or both funds not found or you don\'t have access to them' };
    }

    const fromFund = funds.find(fund => fund._id.equals(fromId));
    const toFund = funds.find(fund => fund._id.equals(toId));

    if (isArchived(fromFund) || isArchived(toFund)) {
        return { status: 400, error: 'An archived fund cannot take part in a transfer' };
    }

    if (fromFund.currentBalance < withdrawnAmount) {
        return { status: 400, error: 'Insufficient amount of money in source fund' };
    }

    // Сумма вводится в валюте фонда-источника, а зачислять её надо
    // в валюте фонда-получателя
    let creditedAmount = withdrawnAmount;
    let rate = 1;

    if (fromFund.currency !== toFund.currency) {
        const exchangeRates = await getRatesObject();

        if (!exchangeRates) {
            return { status: 404, error: 'Exchange rates not found. Please update rates first.' };
        }

        rate = getConversionRate(
            fromFund.currency,
            toFund.currency,
            exchangeRates.rates,
            exchangeRates.base
        );

        if (!rate) {
            return { status: 400, error: `Exchange rate not found for ${fromFund.currency} -> ${toFund.currency}` };
        }

        creditedAmount = roundToCurrencyPrecision(withdrawnAmount * rate, toFund.currency);

        // Донг дешевле бата в тысячи раз, поэтому мелкая сумма
        // после округления может превратиться в ноль
        if (creditedAmount <= 0) {
            return { status: 400, error: `Amount is too small to transfer to ${toFund.currency}` };
        }
    }

    // Create Transactions for each funds
    await new FundTransaction({
        userId,
        fundId: fromFund._id,
        type: 'transfer-out',
        amount: -withdrawnAmount,
        description,
    }).save();

    await new FundTransaction({
        userId,
        fundId: toFund._id,
        type: 'transfer-in',
        amount: creditedAmount,
        description,
    }).save();

    // Update funds
    await Fund.findOneAndUpdate({ _id: fromFund._id, userId }, { $inc: { currentBalance: -withdrawnAmount } });
    await Fund.findOneAndUpdate({ _id: toFund._id, userId }, { $inc: { currentBalance: creditedAmount } });

    return {
        body: {
            message: 'Transferred successfully!',
            withdrawn: { amount: withdrawnAmount, currency: fromFund.currency },
            credited: { amount: creditedAmount, currency: toFund.currency },
            rate
        },
        fromFund,
        toFund
    };
};

module.exports = {
    createFund,
    updateFund,
    deleteFund,
    setFundArchived,
    transferFunds
};
