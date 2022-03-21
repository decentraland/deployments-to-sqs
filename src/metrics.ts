import { metricsDefinitions } from "@dcl/snapshots-fetcher"
import { IMetricsComponent } from "@well-known-components/interfaces"
import { validateMetricsDeclaration } from "@well-known-components/metrics"

export const metricDeclarations = {
  ...metricsDefinitions,
  test_ping_counter: {
    help: "Count calls to ping",
    type: IMetricsComponent.CounterType,
    labelNames: ["pathname"],
  },
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
