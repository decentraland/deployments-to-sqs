# AI Agent Context

**Service Purpose:** Monitors Catalyst content servers for new entity deployments and publishes deployment events to AWS SNS. Acts as the event source for downstream optimization services (Asset Bundle Converter, LODs Generator) that process wearables, emotes, and scenes.

**Key Capabilities:**

- Polls Catalyst `/content/pointer-changes` endpoints across multiple Foundation Catalyst nodes
- Detects deployment deltas (new entity deployments)
- Filters deployments by entity type (wearables, emotes, scenes - excludes profiles and other types)
- Publishes deployment events to AWS SNS topic (`deployments-sns-${env}`)
- Continuously monitors multiple Catalyst nodes in parallel
- Handles deployment metadata (entity ID, pointers, deployer, timestamp, content server URLs)
- Optionally relays dcl-one worlds change feeds (`WORLDS_CHANGES_URLS`) to the events SNS topic as
  worlds-content-server `world/*` events, with a `sourceContentServerUrl` message attribute (a bare
  https origin on `ALLOWED_WORLDS_CONTENT_SERVER_HOSTS`); the cursor is kept in the bucket as
  `worlds-changes-cursor-<host>`. Delivery is at-least-once, so consumers must be idempotent

**Communication Pattern:** 
- Polling-based (periodic GET requests to Catalyst APIs and, when enabled, to dcl-one worlds change feeds)
- Event publishing via AWS SNS (push notifications to subscribers)

**Technology Stack:**

- Runtime: Node.js 24
- Language: TypeScript 5.x
- HTTP Framework: @dcl/http-server
- Queue/Events: AWS SNS (event publishing)
- Component Architecture: @dcl core-components (http-server, metrics, fetch-component, core-commons),
  with @well-known-components still supplying logger, env-config-provider and interfaces

**External Dependencies:**

- Content Servers: Foundation Catalyst nodes (peer.decentraland.org, peer-ec1, peer-ec2, peer-wc1, peer-eu1, peer-ap1)
- Event Bus: AWS SNS (publishes to `deployments-sns-${env}` topic)
- Storage: Catalyst storage (for fetching entity snapshots)

**Event Flow:**

1. Service polls Catalyst `/content/pointer-changes` endpoints
2. Detects new deployments (wearables, emotes, scenes)
3. Publishes deployment event to SNS topic with entity metadata
4. Subscribers (Asset Bundle Converter, LODs Generator, Asset Bundle Registry) consume events via SQS queues

**Worlds Change Relay Flow (optional, `WORLDS_CHANGES_URLS`):**

1. Service polls each dcl-one worlds change feed (`GET <feed>?after=<cursor>&limit=<n>`) from the cursor
   stored in the bucket; with no cursor it starts from the oldest retained row
2. Validates each change and publishes its `world/*` body to the events SNS topic (`EVENTS_SNS_ARN`)
   with `type`, `subType`, the feed attributes and `sourceContentServerUrl`
3. Persists the cursor after publishing (at-least-once delivery)
4. Halts without advancing (error log + `worlds_changes_relay_halted`) when a deployment's
   `contentServerUrls[0]` origin differs from the feed source, or the feed answers 401/403/409/410

**Deployment Event Schema:** Includes entityId, entityType, pointers, deployer, timestamp, contentServerUrls
