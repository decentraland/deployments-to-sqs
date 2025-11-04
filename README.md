# Deployments to SQS

[![Coverage Status](https://coveralls.io/repos/github/decentraland/deployments-to-sqs/badge.svg?branch=coverage)](https://coveralls.io/github/decentraland/deployments-to-sqs?branch=coverage)

This service continuously monitor for deployments that have been made on any Foundation Catalyst.

The service checks for new deployments by sending GET requests to the specified API endpoint [/content/pointer-changes](https://decentraland.github.io/catalyst-api-specs/#tag/Content-Server/operation/getPointerChanges). This continuous monitoring ensures prompt identification of any deployment changes.

When a new deployment delta is detected, the service publishes its data to the configured Amazon SNS topic (`deployments-sns-${env}`). Therefore, any stakeholder that need to react over these deployments can subscribe to this topic and start receiving notifications about new deployments.

## Deployments being informed by this service

As of the time of writing, this service identifies and reports deployments of:
* Wearables
* Emotes
* Scenes

Deployments of entities not listed here, such as profiles, are excluded. These other entities are ignored because, as of the time of writing, there is no need to react to their deployments.

## Foundation Catalysts

As of the time of writing, the following nodes are the ones being fetched to check for any new deployments:

* https://peer.decentraland.org
* https://peer-ec1.decentraland.org
* https://peer-ec2.decentraland.org
* https://peer-wc1.decentraland.org
* https://peer-eu1.decentraland.org
* https://peer-ap1.decentraland.org

## AI Agent Context

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
