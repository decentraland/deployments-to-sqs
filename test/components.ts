// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment

import { createRunner, createLocalFetchComponent } from '@dcl/test-helpers'

import { main } from '../src/service'
import { TestComponents } from '../src/types'
import { initComponents as originalInitComponents } from '../src/components'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { configMock, metricsMock, pgMock, processedRegistryMock } from './mocks/components'

/**
 * Behaves like Jest "describe" function, used to describe a test for a
 * use case, it creates a whole new program and components to run an
 * isolated test.
 *
 * State is persistent within the steps of the test.
 */
export const test = createRunner<TestComponents>({
  main,
  initComponents
})

async function initComponents(): Promise<TestComponents> {
  const components = await originalInitComponents()

  const { config } = components

  const storage = createInMemoryStorage()

  return {
    ...components,
    storage,
    localFetch: await createLocalFetchComponent(config),
    config: configMock,
    metrics: metricsMock,
    // Stub the synchronizer so `main()` doesn't kick off a real catalyst sync
    // during tests (CONTENT_SERVER_URLS now resolves to a real allowlisted host
    // to satisfy the startup allowlist guard).
    synchronizer: { syncWithServers: jest.fn().mockResolvedValue({}) } as any,
    // Stubbed so the suite needs no database: the real component would connect and
    // run migrations on start. Registry behaviour is covered by its own unit tests.
    pg: pgMock,
    processedRegistry: processedRegistryMock
  }
}
