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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
