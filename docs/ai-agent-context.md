# AI Agent Context

**Service Purpose:** Monitors Catalyst content servers for new entity deployments and publishes deployment events to AWS SNS. Acts as the event source for downstream optimization services (Asset Bundle Converter, LODs Generator) that process wearables, emotes, and scenes.

**Key Capabilities:**

- Polls Catalyst `/content/pointer-changes` endpoints across multiple Foundation Catalyst nodes
- Detects deployment deltas (new entity deployments)
- Filters deployments by entity type (wearables, emotes, scenes - excludes profiles and other types)
- Publishes deployment events to AWS SNS topic (`deployments-sns-${env}`)
- Continuously monitors multiple Catalyst nodes in parallel
- Handles deployment metadata (entity ID, pointers, deployer, timestamp, content server URLs)

**Communication Pattern:** 
- Polling-based (periodic GET requests to Catalyst APIs)
- Event publishing via AWS SNS (push notifications to subscribers)

**Technology Stack:**

- Runtime: Node.js
- Language: TypeScript 4.x
- HTTP Framework: @well-known-components/http-server
- Queue/Events: AWS SNS (event publishing)
- Component Architecture: @well-known-components (logger, metrics, http-server, env-config-provider)

**External Dependencies:**

- Content Servers: Foundation Catalyst nodes (peer.decentraland.org, peer-ec1, peer-ec2, peer-wc1, peer-eu1, peer-ap1)
- Event Bus: AWS SNS (publishes to `deployments-sns-${env}` topic)
- Storage: Catalyst storage (for fetching entity snapshots)

**Event Flow:**

1. Service polls Catalyst `/content/pointer-changes` endpoints
2. Detects new deployments (wearables, emotes, scenes)
3. Publishes deployment event to SNS topic with entity metadata
4. Subscribers (Asset Bundle Converter, LODs Generator, Asset Bundle Registry) consume events via SQS queues

**Deployment Event Schema:** Includes entityId, entityType, pointers, deployer, timestamp, contentServerUrls
