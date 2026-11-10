# Boardroom IMEI checker

A small Express application with a responsive microsoldering themed frontend. It validates a 15 digit IMEI (including its Luhn check digit), then asks IMEILookup for device information. Provider credentials are only used on the server.

## Requirements

- Node.js 20 or newer
- An approved IMEILookup API account, API key, and a service ID available to that account

## Run locally

1. Install packages with `npm install`.
2. Copy `.env.example` to `.env` and set the provider values.
3. Run `npm start` and open `http://localhost:3000`.

`npm run dev` starts the server with Node's watch mode. The frontend is served by Express from `public/`, so local development uses same-origin requests and does not need CORS configuration.

## IMEILookup configuration

The adapter follows the [IMEILookup REST API documentation](https://developers.imeilookup.com/docs/intro/):

- Places an order with `POST /order/single`, JSON `{ "imei": "<15 digits>", "serviceId": <number> }`, and the API key in the `access-key` header.
- Polls `GET /order/single?id=<order id>` while the order is waiting or processing. It never automatically submits a second order for the same request.
- Uses a 70 second initial request timeout because the provider can spend up to 55 seconds waiting for a result. A timeout or server error may leave an order in progress; check the provider order history before trying again.

Get the available service IDs from your account's service list (`GET /service?page=0&size=10` with the `access-key` header) and check its description for IMEI input and the required report fields. The provider's service catalog and field coverage vary by account. The API also requires your server's outbound IP address to be allow-listed in the provider dashboard. See the official [authentication guide](https://developers.imeilookup.com/docs/authentication/) and [order/polling guide](https://developers.imeilookup.com/docs/guides/orders-and-polling/).

The result normalizer accepts object results and common text reports in which fields are listed as `Name: value`. Recognized field aliases:

| Result | Accepted provider fields |
| --- | --- |
| Serial number | `serialNumber`, `serial_number`, `serial`, `sn`, `SN` |
| Model | `model`, `modelName`, `deviceModel`, `productName`, `description` |
| Storage | `storage`, `capacity`, `memory`, `storageSize` |
| Color | `color`, `colour`, `deviceColor`, `finish` |
| iCloud status | `icloudStatus`, `iCloudStatus`, `icloud_status`, `fmiStatus`, `findMyStatus`, `activationLock`, `activation_lock` |

Do not put API credentials in `public/` or browser JavaScript. The example key is a placeholder. A valid account service ID must be set before the application can submit live lookups.

## API

`POST /api/check-imei`

Request:

```json
{ "imei": "356938035643809" }
```

Success:

```json
{
  "success": true,
  "data": {
    "imei": "356938035643809",
    "serialNumber": "...",
    "model": "...",
    "storage": "...",
    "color": "...",
    "icloudStatus": "..."
  }
}
```

Invalid input returns HTTP 400. Provider configuration and provider failures return safe client messages without provider credentials or stack traces. Lookup requests are limited to five per IP per 15 minutes; the built-in limiter uses in-memory storage, so deploy a shared rate-limit store when running multiple server instances.

## Provider webhook

`POST /api/webhooks/imei-lookup` accepts JSON updates containing an `orderId` (or `order_id`) and a status (`completed`, `failed`, `processing`, or `waiting`). Optional device results can be sent as `result`, `data`, `deviceData`, or `device_data`. The app records provider order IDs and results in its local SQLite database at `data/imei-checker.sqlite`, then applies authenticated callback updates to matching orders. Webhook event IDs are deduplicated; repeated events receive an HTTP 200 acknowledgment. Unknown order IDs are recorded for reconciliation and also acknowledged.

Configure `IMEI_WEBHOOK_SECRET` in `.env` and in the provider webhook settings. Requests can authenticate with `X-IMEILookup-Signature: sha256=<hex HMAC-SHA256 of the exact raw request body>`, or a shared token in `X-Webhook-Token` / `Authorization: Bearer`. The webhook route fails closed if the secret is missing. `IMEI_WEBHOOK_IPS` optionally restricts callers to a comma-separated provider IP allow-list. Keep the secret private and use HTTPS. SQLite is intended for a single app instance with persistent disk; use a shared production database before running multiple instances.

## Deployment notes

- Terminate HTTPS at a trusted reverse proxy. Set `TRUST_PROXY=true` only when the app is behind a single trusted proxy so rate limits use the client IP correctly.
- Set `NODE_ENV=production` and `FRONTEND_ORIGIN` to the exact browser origin when hosting the frontend separately. For a same-origin deployment, leave `FRONTEND_ORIGIN` blank.
- Keep `.env` out of version control and inject secrets through the deployment secret manager.
- On Vercel, the app exports its Express handler and uses `/tmp/imei-checker.sqlite` so function startup does not try writing into the read-only deployment bundle. Vercel temporary storage is not durable or shared between function instances; use a managed database before relying on order history or webhook updates in production. Vercel serves files from `public/` as static assets.
- The service is independent and not affiliated with or endorsed by Apple Inc. Check only devices you own or are authorized to inspect. Provider results and field coverage depend on the provider.
# phoeniximei
