# Shopify <-> OMS Integration

## Architecture

```text
Shopify
  | orders/paid webhook (HMAC verified)
  v
Integration API -> SQLite event/audit record -> BullMQ/Redis
                                         |
                                         v
                                      OMS REST API

OMS status update -> authenticated /oms/updates -> BullMQ/Redis
                                            -> Shopify metafields + order note
```

The Express integration accepts Shopify webhooks and OMS updates. Shopify deliveries are acknowledged quickly and processed by BullMQ workers. The mock OMS is a separate Express server on port 3001.

## Technical decisions

- GraphQL is used for Shopify order retrieval and updates.
- Metafields store the external OMS ID and status; an append-only order-note line provides merchant-visible context.
- SQLite/Prisma provides a lightweight demo database. BullMQ/Redis provides durable jobs and retries.
- Shopify order IDs are the cross-system business key. OMS writes use `X-Idempotency-Key` with that ID.
- Redis is required in this implementation. Start it with `docker compose up -d redis`.

## Data model

`SyncEvent` stores:

- Shopify and OMS identifiers
- webhook ID and synchronization direction
- status and retry/error information
- original payload and timestamps

The unique `webhookId` column prevents duplicate Shopify deliveries and duplicate OMS callback events. SQLite is appropriate for the demo; PostgreSQL is the production replacement.

## Reliability

- Shopify webhook HMAC-SHA256 verification is required before processing.
- The Shopify webhook ID is stored once atomically in SQLite. BullMQ also uses a deterministic job ID.
- OMS 500 responses and network failures are retried with exponential backoff.
- OMS order creation is protected by both a lookup and `X-Idempotency-Key`.
- OMS callback duplicate deliveries are deduplicated using a deterministic external-order/status key.
- Replays, restarts, and prolonged OMS downtime remain in Redis; a failed sync is retained as a database audit record.
- Real infrastructure should retain Redis and the database, run workers separately from public web processes, and alert on dead-lettered jobs.

## Scaling

At roughly 100 orders/day, SQLite plus a small Redis instance and one worker is sufficient. At 10,000/day:

- use PostgreSQL and managed Redis
- run multiple worker instances and separate Shopify/OMS queues
- use queue concurrency and OMS-specific throughput limits
- use GraphQL cost-aware throttling and batch/bulk operations where appropriate
- partition and retain sync-event data with a retention policy
- use metrics, traces, dead-letter queues, and horizontal replicas behind a load balancer

## Security

- Verify Shopify webhook HMAC signatures against the raw JSON body.
- Store Shopify, OMS, Redis, and database secrets in the environment or a secret manager.
- Send OMS API keys as bearer credentials and validate OMS callback requests.
- Keep a private OMS callback endpoint behind TLS, allowlisting, signatures, or mTLS where possible.
- Do not expose the sync-status endpoint publicly in production; require authentication or remove it.
- Restrict CORS and apply rate limiting, request-size limits, and structured redaction.

## Production improvements

- replace SQLite with PostgreSQL and add migrations
- replace environment-only configuration checks with startup validation
- add a persistent OMS inbox/outbox and circuit breaker
- add signed OMS callbacks and replay protection
- add GraphQL bulk query support and token refresh/secrets rotation
- add DLQ replay tooling and dashboards
- run integration and contract tests in CI