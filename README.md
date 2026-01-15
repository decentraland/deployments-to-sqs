# Deployments to SQS Server

[![Coverage Status](https://coveralls.io/repos/github/decentraland/deployments-to-sqs/badge.svg?branch=main)](https://coveralls.io/github/decentraland/deployments-to-sqs?branch=main)

This service continuously monitors Foundation Catalyst nodes for new entity deployments (wearables, emotes, and scenes) and publishes deployment events to AWS SNS. It acts as the event source for downstream optimization services like Asset Bundle Converter, LODs Generator, and Asset Bundle Registry.

As of the time of writing, this service identifies and reports deployments of:
- Wearables
- Emotes
- Scenes

Deployments of entities not listed here, such as profiles, are excluded. These other entities are ignored because, as of the time of writing, there is no need to react to their deployments.

## Table of Contents

- [Features](#features)
- [Dependencies & Related Services](#dependencies--related-services)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Service](#running-the-service)
- [Testing](#testing)

## Features

- **Deployment Monitoring**: Polls Catalyst `/content/pointer-changes` endpoints across multiple Foundation Catalyst nodes in parallel
- **Deployment Detection**: Detects deployment deltas (new entity deployments) for wearables, emotes, and scenes
- **Event Publishing**: Publishes deployment events to AWS SNS topics
- **Entity Filtering**: Filters deployments by entity type, excluding profiles and other non-relevant entities
- **Metadata Handling**: Processes deployment metadata including entity ID, pointers, deployer, timestamp, and content server URLs
- **Automatic Reconnection**: Handles connection failures with configurable exponential backoff reconnection strategies

## Dependencies & Related Services

This service interacts with the following services:

- **[Catalyst Content Servers](https://github.com/decentraland/catalyst)**: Polls `/content/pointer-changes` endpoints for new deployments
- **[Asset Bundle Converter](https://github.com/decentraland/asset-bundle-converter)**: Subscribes to deployment events for asset processing
- **[LODs Generator](https://github.com/decentraland/lods-generator)**: Subscribes to deployment events for LOD generation
- **[Asset Bundle Registry](https://github.com/decentraland/asset-bundle-registry)**: Subscribes to deployment events for registry updates
- **AWS SNS**: Publishes deployment notifications.
 **AWS S3** (optional): Stores processed snapshot markers when `BUCKET` is configured
- **Foundation Catalyst Nodes**:
  - https://peer.decentraland.org
  - https://peer-ec1.decentraland.org
  - https://peer-ec2.decentraland.org
  - https://peer-wc1.decentraland.org
  - https://peer-eu1.decentraland.org
  - https://peer-ap1.decentraland.org

## Getting Started

### Prerequisites

Before running this service, ensure you have the following installed:

- **Node.js**: Version 22.x or higher (LTS recommended)
- **Yarn**: Version 1.22.x or higher
- **Docker**: For containerized deployment
- **AWS Credentials**: Configured for SNS and optionally S3 access

### Installation

1. Clone the repository:

```bash
git clone https://github.com/decentraland/deployments-to-sqs.git
cd deployments-to-sqs
```

2. Install dependencies:

```bash
yarn install
```

3. Build the project:

```bash
yarn build
```

### Configuration

The service uses environment variables for configuration.
Create a `.env` file in the root directory containing the environment variables for the service to run.
Use the `.env.default` variables as an example.


### Running the Service

#### Running in development mode

To run the service in development mode:

```bash
yarn start
```

The service will start polling the configured Catalyst nodes and publishing deployment events to SNS.

## Testing

This service includes comprehensive test coverage with both unit and integration tests.

### Running Tests

Run all tests with coverage:

```bash
yarn test
```

Run tests in watch mode:

```bash
yarn test --watch
```

Run only unit tests:

```bash
yarn test test/unit
```

Run only integration tests:

```bash
yarn test test/integration
```

### Test Structure

- **Unit Tests** (`test/unit/`): Test individual components and functions in isolation
  - `adapters/`: Tests for deployer, entity-downloader, and SNS publisher
  - `logic/`: Tests for deployment message building
- **Integration Tests** (`test/integration/`): Test the complete request/response cycle

For detailed testing guidelines and standards, refer to our [Testing Standards](https://github.com/decentraland/docs/tree/main/development-standards/testing-standards) documentation.

## AI Agent Context

For detailed AI Agent context, see [docs/ai-agent-context.md](docs/ai-agent-context.md).
