# Wanna Track API

A RESTful API for managing personal expenses and funds.

## Features

- User authentication and authorization
- CRUD operations for expenses
- CRUD operations for categories
- CRUD operations for funds
- Fund transactions tracking
- Linking expenses with funds
- Default fund support
- Fund balance management
- Fund transfers between accounts

## API Endpoints

### Authentication

Data routes take the caller's identity from credentials, never from a `userId`
in the query or body (it is ignored if sent):

- web: `Authorization: Bearer <accessToken>`, from signin, signup or refresh
- Telegram bot: `X-Telegram-Bot-Secret` (equal to `TELEGRAM_BOT_SECRET`) and
  `X-Telegram-User-Id`; the request acts as the user linked to that Telegram
  account. The bot may only call `GET /api/category`, `GET /api/funds`,
  `POST /api/cost`, `GET /api/tags`, `GET /api/me` and `PUT /api/me/active-tag`
  (plus the two bot routes under `/api/telegram`)

No credentials, an invalid or expired token, or an unlinked Telegram id is a
401; a bot call to any other route is a 403; a bearer and bot headers together
are a 400.

While `AUTH_ENFORCE` is not `true`, clients deployed before this scheme keep
working: the `refreshToken` cookie identifies the web user, and the bot secret
with a `userId` (no Telegram id) identifies the bot's user. Each such request
logs `[auth-legacy]`. With `AUTH_ENFORCE=true` both are a 401.

Routes that take an id only find the caller's own records: anybody else's id,
or a malformed one, is a 404.

- `POST /api/auth/signup` - Register a new user
- `POST /api/auth/signin` - Sign in; sets the `refreshToken` cookie
- `POST /api/auth/refresh` - Exchange the `refreshToken` cookie for a new access token; rotates the cookie
- `GET /api/auth/` - Older silent-auth endpoint, kept for web bundles that predate `/refresh`
- `POST /api/auth/signout` - Clear the `refreshToken` cookie

Signup, signin and refresh return the user
(`id`, `username`, `email`, `defaultCurrency`, `telegramId`, `verified`, `activeTag`) and an `accessToken`.

### Me
- `GET /api/me` - The caller, in the same shape as signin
- `PUT /api/me/active-tag` - `{ "tag": "japan-2026" }` sets the tag every new cost gets
  unless it says otherwise; `null`, or a tag that normalises to nothing, clears it.
  Returns the user

### Categories
- `GET /api/category` - Get the global categories and the caller's own
- `POST /api/category` - Create a category owned by the caller

### Costs
- `GET /api/costs` - Get the caller's costs, grouped by category (`dateFrom`, `dateTo`).
  With `tag`, only costs carrying it, and the dates become optional (absent: all time).
  Each cost carries `tags`, `currency` and `fundAmount` (null without a fund)
- `POST /api/cost` - Create a cost; the fund, if given, must be the caller's,
  the category must be global or the caller's, and `amount` must be a positive number
- `PATCH /api/cost/:id` - `{ "tags": [...] }` replaces the tags of one of the caller's costs;
  nothing else is editable
- `GET /api/tags` - The caller's tags as `{ tag, count, total, currency, firstDate, lastDate }`,
  `total` in the default currency, most recently used first

Tags are normalised wherever they enter: trimmed, lowercased, inner whitespace
turned into `-`, only letters (any script), digits, `-` and `_` kept, at most 32
characters and 10 tags per cost, duplicates removed. A tag left empty is dropped,
not rejected.

### Funds
- `GET /api/funds` - Get all funds
- `POST /api/funds` - Create a new fund
- `PUT /api/funds/:id` - Update a fund
- `DELETE /api/funds/:id` - Delete a fund
- `GET /api/funds/:id` - Get fund details
- `GET /api/funds/:id/transactions` - Get fund transactions
- `GET /api/funds/total` - Total of all funds in the caller's default currency
- `POST /api/funds/transfer` - Transfer money between funds

### Telegram
- `GET /api/telegram/telegram-binding-link` - Link that binds the caller's Telegram account
- `POST /api/telegram/telegram-unbind` - Unbind the caller's Telegram account
- `POST /api/telegram/telegram-bind`, `GET /api/telegram/user-by-telegram/:telegramId` -
  bot only, `X-Telegram-Bot-Secret`

### Exchange rates
- `GET /api/exchange-rates/current`, `GET /api/exchange-rates/currencies` - Public
- `POST /api/exchange-rates/update` - Fetch fresh rates from the paid API by hand;
  needs `X-Admin-Secret` equal to `ADMIN_SECRET`, and does not exist (404) while
  `ADMIN_SECRET` is unset. A daily cron updates the rates without it.

## Request/Response Examples

### Create a new cost with fund
```json
POST /api/cost
{
    "amount": 1500,
    "currency": "JPY",          // Optional: default is the fund's currency, else the user's
    "category": "categoryId",
    "comment": "Ramen",
    "date": "2026-10-25T10:00:00Z",
    "fundId": "fundId",         // Optional: link cost to a specific fund
    "tags": ["japan-2026"]      // Optional: absent means the user's active tag; [] means none
}
```

`amount` and `currency` are what was spent. When the fund holds another currency
the fund is debited `fundAmount`: the amount converted at the stored rate and
rounded to the fund currency's precision; the balance check uses it too, and
the fund transaction's description names the original (`Ramen (1500 JPY)`).
`rate` (currency to the user's default currency) is always computed by the
server; a `rate` in the body is ignored. A currency without a stored rate is a
400 and nothing is debited.

```json
{
    "amount": 1500,
    "currency": "JPY",
    "fundAmount": 366.71,
    "rate": 0.2444742,
    "tags": ["japan-2026"],
    ...
}
```

### Create a new fund
```json
POST /api/funds
{
    "name": "Main Account",
    "icon": "💰",
    "description": "Primary spending account",
    "initialBalance": 1000,
    "isDefault": true
}
```

### Transfer between funds
```json
POST /api/funds/transfer
{
    "fromFundId": "sourceFundId",
    "toFundId": "targetFundId",
    "amount": 500,
    "description": "Transfer to savings"
}
```

`amount` is in the currency of the source fund. When the two funds hold
different currencies the amount is converted at the stored exchange rate and
rounded to the precision of the target currency, so the response reports both
sides of the operation:

```json
{
    "message": "Transferred successfully!",
    "withdrawn": { "amount": 1000000, "currency": "VND" },
    "credited": { "amount": 1270.95, "currency": "THB" },
    "rate": 0.0012709542237442923
}
```

## Known Issues

Both of the below touch how fund balances are written. They are known, they
predate the multi-currency work, and they are meant to be picked up together
as a separate feature — the same handlers have to be rewritten for either one,
so doing them in one pass is cheaper than twice.

### Balance updates are not atomic

`POST /api/funds/transfer` performs four independent writes: two
`FundTransaction` documents and two `$inc` updates, one per fund. Each write is
atomic on its own, the sequence is not. If the process dies between the debit
and the credit, the money is withdrawn and never arrives. It cannot be
recovered afterwards: a balance is stored on the fund as a number rather than
derived from the transaction history, so nothing recomputes it.

`POST /api/cost` has the same gap on a smaller scale — the fund balance is
saved first and the `Cost` document after it, so a crash in between leaves
money spent with no expense recorded.

The realistic trigger is not exotic: a CapRover redeploy, an OOM kill or a
dropped Atlas connection while a request is in flight.

Multi-document transactions need a replica set, and every Atlas cluster
(including the free M0 tier) is one, so the fix is available without changing
infrastructure:

```js
const session = await mongoose.startSession();

try {
  await session.withTransaction(async () => {
    await outgoingTransaction.save({ session });
    await incomingTransaction.save({ session });
    await Fund.findByIdAndUpdate(fromFundId, { $inc: { currentBalance: -withdrawnAmount } }, { session });
    await Fund.findByIdAndUpdate(toFundId, { $inc: { currentBalance: creditedAmount } }, { session });
  });
} finally {
  await session.endSession();
}
```

Worth knowing before starting:

- every operation inside the block needs `{ session }`; one that is missing it
  silently escapes the transaction and survives a rollback
- `withTransaction` may run the callback again after a transient error such as
  a primary re-election, so it must hold no side effects outside the database
- a standalone local `mongod` rejects transactions with
  `Transaction numbers are only allowed on a replica set member`; run the test
  container with `--replSet` to reproduce the production setup

### Concurrent operations can overdraw a fund

The balance check and the balance update are separate steps. In
`POST /api/funds/transfer` the handler reads the fund, compares
`currentBalance` against the requested amount, and only later applies `$inc`.
Two requests that arrive together both pass the check and both go through,
leaving the fund negative.

`POST /api/cost` is worse, because it does a read-modify-write
(`fund.currentBalance -= amount; await fund.save()`): of two concurrent
expenses, one decrement can be lost entirely and the balance ends up higher
than it should be.

A transaction alone does not fix this — the stale read happens inside it just
as well. The check has to move into the update itself, so the database
evaluates the condition:

```js
const updated = await Fund.findOneAndUpdate(
  { _id: fromFundId, currentBalance: { $gte: withdrawnAmount } },
  { $inc: { currentBalance: -withdrawnAmount } },
  { new: true, session }
);

if (!updated) {
  return res.status(400).json({ error: 'Insufficient amount of money in source fund' });
}
```

## Technologies Used

- Node.js
- Express.js
- MongoDB
- Mongoose
- JWT for authentication

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   MONGODB_URI=your_mongodb_uri
   JWT_SECRET=your_jwt_secret
   PORT=3000
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Development

To run the server in development mode with auto-reload:
```bash
npm run dev
```

## Testing

To run tests:
```bash
npm test
```