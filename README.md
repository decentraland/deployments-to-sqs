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
