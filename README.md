# Sky Traders

Sky Traders is a hosted forex trading platform with server-side accounts, recurring Stripe subscriptions, an owner management console, adverts, and an MT5 status bridge.

## Plans

- **Starter:** $5/month with a seven-day Stripe trial.
- **Professional:** $20/month.

## Run locally

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and fill in the database, JWT, Stripe, and MT5 values.
3. Install dependencies with `npm install`.
4. Start the server with `npm start`.
5. Open `http://localhost:10000`.

The server initializes the `users` and `adverts` tables automatically. Passwords are hashed with bcrypt and are never sent to the browser or stored in `localStorage`.

## Account activation and approvals

Every new account starts with a `$0.00` balance and `pending` trading access. Users can submit either an MT5 connection request or a deposit request with a payment reference. Trading controls remain locked until management approves one of those requests. Approved deposits update the server-side balance; approved MT5 requests mark the trading connection active.

The management console is available from the login screen. It lists users, balances, trading state, and pending requests, with approve/reject controls. It also publishes notices through server-sent events so connected users receive them immediately. Notices can be closed or opened from the broadcast banner.

## Render deployment

Create a Render PostgreSQL database and a Node web service using `render.yaml`, or set these environment variables manually:

- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_STARTER_PRICE_ID`
- `STRIPE_PROFESSIONAL_PRICE_ID`
- `MT5_STATUS_URL` (the URL of a secure MT5 bridge service)

For permanent data, use Render PostgreSQL. The local no-`DATABASE_URL` fallback is temporary memory storage for interface testing only and must not be used as production storage.

In Stripe, create two recurring prices, set their price IDs in Render, and register `https://YOUR-DOMAIN/api/payments/webhook` for checkout completion and subscription updates. Never commit real secret values.

## Management console

The hidden key button opens the owner information panel for Ruti Nice: `0700291533`. That panel links to the password-protected management console. The example password is `1562`; set a stronger `ADMIN_PASSWORD` before publishing. The console lists all registered users and publishes notices that appear for every signed-in user.

## MT5 status

The browser never connects directly to MetaTrader. Configure `MT5_STATUS_URL` with a server-side MT5 bridge that returns JSON such as:

```json
{
	"connected": true,
	"message": "Account connected",
	"account": "123456",
	"balance": 10000,
	"positions": 2
}
```

Do not expose MT5 credentials in this repository. The existing quote and order controls remain local platform behavior until a broker execution bridge is intentionally connected.
