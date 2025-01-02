import { metricsDefinitions } from '@dcl/snapshots-fetcher'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { validateMetricsDeclaration, getDefaultHttpMetrics } from '@well-known-components/metrics'

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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
