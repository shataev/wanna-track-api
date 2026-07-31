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
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user

### Categories
- `GET /api/categories` - Get all categories
- `POST /api/categories` - Create a new category
- `PUT /api/categories/:id` - Update a category
- `DELETE /api/categories/:id` - Delete a category

### Costs
- `GET /api/costs` - Get all costs (with optional date range filter)
- `POST /api/cost` - Create a new cost
- `PUT /api/cost/:id` - Update a cost
- `DELETE /api/cost/:id` - Delete a cost

### Funds
- `GET /api/funds` - Get all funds
- `POST /api/funds` - Create a new fund
- `PUT /api/funds/:id` - Update a fund
- `DELETE /api/funds/:id` - Delete a fund
- `GET /api/funds/:id` - Get fund details
- `GET /api/funds/:id/transactions` - Get fund transactions
- `POST /api/funds/transfer` - Transfer money between funds

## Request/Response Examples

### Create a new cost with fund
```json
POST /api/cost
{
    "amount": 100,
    "category": "categoryId",
    "comment": "Grocery shopping",
    "userId": "userId",
    "date": "2024-03-20T10:00:00Z",
    "fund": "fundId"  // Optional: link cost to a specific fund
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
    "isDefault": true,
    "userId": "userId"
}
```

### Transfer between funds
```json
POST /api/funds/transfer
{
    "userId": "userId",
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