import { metricsDefinitions } from '@dcl/snapshots-fetcher'
import { getDefaultHttpMetrics } from '@dcl/http-server'
import { validateMetricsDeclaration } from '@dcl/metrics'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...metricsDefinitions,
  ...logMetricDeclarations,
  test_ping_counter: {
    help: 'Count calls to ping',
    type: IMetricsComponent.CounterType,
    labelNames: ['pathname']
  },
  sns_publish_success: {
    help: 'Count successful SNS publishes',
    type: IMetricsComponent.CounterType,
    labelNames: ['type']
  },
  sns_publish_failure: {
    help: 'Count failed SNS publishes',
    type: IMetricsComponent.CounterType,
    labelNames: ['type']
  },
  entity_download_success: {
    help: 'Count successful entity downloads',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  },
  entity_download_failure: {
    help: 'Count failed entity downloads',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType', 'retryable']
  },
  schedule_entity_deployment_attempt: {
    help: 'Count attempts to schedule entity deployment',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  },
  entity_already_stored: {
    help: 'Count entities already stored',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  },
  entity_deployment_success: {
    help: 'Count successful entity deployments',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  },
  entity_deployment_failure: {
    help: 'Count failed entity deployments',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType', 'retryable']
  },
  entity_deployment_queue_failure: {
    help: 'Count deployments whose download-queue promise rejected (e.g. the queue timeout elapsed). Counted separately from entity_deployment_failure because a timed-out job keeps running and may still succeed.',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  },
  entity_skipped_old: {
    help: 'Count entities skipped because they are older than the configured max age',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  },
  entity_skipped_invalid_id: {
    help: 'Count entities skipped because their entityId is not a bare CID (path/key-injection guard)',
    type: IMetricsComponent.CounterType,
    labelNames: ['entityType']
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
