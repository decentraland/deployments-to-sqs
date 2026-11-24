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
  download_queue_size: {
    help: 'Deployment jobs queued but not started. Counts jobs, not distinct entities.',
    type: IMetricsComponent.GaugeType
  },
  download_queue_pending: {
    help: 'Deployment jobs currently executing. Persistently at the queue concurrency means saturated.',
    type: IMetricsComponent.GaugeType
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
  },
  worlds_changes_relayed: {
    help: 'Count worlds change feed events published to the events SNS topic',
    type: IMetricsComponent.CounterType,
    labelNames: ['feed', 'subType']
  },
  worlds_changes_dropped: {
    help: 'Count worlds change feed rows skipped because they failed validation',
    type: IMetricsComponent.CounterType,
    labelNames: ['feed', 'reason']
  },
  worlds_changes_relay_failure: {
    help: 'Count worlds change relay failures (load_cursor, poll, publish, save_cursor) that triggered a backoff',
    type: IMetricsComponent.CounterType,
    labelNames: ['feed', 'operation', 'error']
  },
  worlds_changes_relay_halted: {
    help: 'Count worlds change relay halts that need an operator (source_mismatch, http_401/403/409/410)',
    type: IMetricsComponent.CounterType,
    labelNames: ['feed', 'reason']
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
