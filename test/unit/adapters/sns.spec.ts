import { SNSClient } from '@aws-sdk/client-sns'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import {
  createSnsDeploymentPublisherComponent,
  createSnsEventPublisherComponent,
  SnsType
} from '../../../src/adapters/sns'
import * as BuildDeploymentMessageFns from '../../../src/logic/build-deployment-message'
import { AppComponents, SnsPublishError } from '../../../src/types'
import { configMock, logsMock, metricsMock } from '../../mocks/components'
import { Events } from '@dcl/schemas'

jest.mock('@aws-sdk/client-sns', () => ({
  ...jest.requireActual('@aws-sdk/client-sns'),
  SNSClient: jest.fn().mockReturnValue({
    send: jest.fn()
  })
}))

jest.spyOn(BuildDeploymentMessageFns, 'buildDeploymentMessage')

describe('SnsPublisherComponent', () => {
  const { buildDeploymentMessage } = BuildDeploymentMessageFns

  let components: jest.Mocked<Pick<AppComponents, 'config' | 'logs' | 'metrics'>>

  let mockEntity: DeployableEntity & { metadata: any }
  let mockServers: string[]

  let mockClient: SNSClient

  beforeEach(() => {
    components = {
      config: configMock,
      logs: logsMock,
      metrics: metricsMock
    }

    mockEntity = {
      entityId: 'entity-id',
      entityType: 'scene',
      markAsDeployed: jest.fn(),
      pointers: ['pointer1'],
      authChain: [],
      entityTimestamp: Date.now(),
      localTimestamp: Date.now(),
      metadata: {
        multiplayerId: null
      }
    } as DeployableEntity & { metadata: any }

    mockServers = ['server1', 'server2']

    mockClient = new SNSClient({})
  })

  it('should publish deployment message successfully', async () => {
    const arn = 'deployment-arn'
    mockClient.send = jest.fn().mockResolvedValueOnce({ MessageId: 'message-id', SequenceNumber: '12345' })
    mockArnConfigImplementation('SNS_ARN', arn)

    const publisher = await createSnsDeploymentPublisherComponent(components)
    await publisher.publishMessage(mockEntity, mockServers)

    const expectedMessage = {
      entity: mockEntity,
      contentServerUrls: mockServers
    }

    expect(buildDeploymentMessage).toHaveBeenCalledWith(SnsType.DEPLOYMENT, mockEntity, mockServers)
    expectSendToHaveBeenCalledWith(expectedMessage, arn)
    expect(metricsMock.increment).toHaveBeenCalledWith('sns_publish_success', { type: SnsType.DEPLOYMENT })
  })

  it('should publish event message successfully', async () => {
    const arn = 'event-arn'
    mockClient.send = jest.fn().mockResolvedValueOnce({ MessageId: 'message-id', SequenceNumber: '12345' })
    mockArnConfigImplementation('EVENTS_SNS_ARN', arn)

    const publisher = await createSnsEventPublisherComponent(components)
    await publisher.publishMessage(mockEntity, mockServers)

    const expectedMessage = {
      type: Events.Type.CATALYST_DEPLOYMENT,
      subType: mockEntity.entityType as Events.SubType.CatalystDeployment,
      entity: mockEntity,
      contentServerUrls: mockServers
    }

    expect(buildDeploymentMessage).toHaveBeenCalledWith(SnsType.EVENT, mockEntity, mockServers)
    expectSendToHaveBeenCalledWith(expectedMessage, arn)
    expect(metricsMock.increment).toHaveBeenCalledWith('sns_publish_success', { type: SnsType.EVENT })
  })

  it('should handle publish error and increment failure metric', async () => {
    mockClient.send = jest.fn().mockRejectedValueOnce(new Error('AWS error'))

    const publisher = await createSnsDeploymentPublisherComponent(components)

    await expect(publisher.publishMessage(mockEntity, mockServers)).rejects.toThrow(SnsPublishError)

    expect(buildDeploymentMessage).toHaveBeenCalledWith(SnsType.DEPLOYMENT, mockEntity, mockServers)
    expect(metricsMock.increment).toHaveBeenCalledWith('sns_publish_failure', { type: SnsType.DEPLOYMENT })
  })

  describe('isMultiplayer attribute', () => {
    it('should set isMultiplayer to true for scenes with multiplayerId', async () => {
      const multiplayerEntity = {
        ...mockEntity,
        metadata: { multiplayerId: 'mp-room-123' }
      }

      mockClient.send = jest.fn().mockResolvedValueOnce({ MessageId: 'message-id' })
      mockArnConfigImplementation('SNS_ARN', 'test-arn')

      const publisher = await createSnsDeploymentPublisherComponent(components)
      await publisher.publishMessage(multiplayerEntity, mockServers)

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            MessageAttributes: expect.objectContaining({
              isMultiplayer: { DataType: 'String', StringValue: 'true' }
            })
          })
        })
      )
    })

    it('should set isMultiplayer to false for non-scene entities', async () => {
      const profileEntity = {
        ...mockEntity,
        entityType: 'profile',
        metadata: { anyData: 'value' }
      }

      mockClient.send = jest.fn().mockResolvedValueOnce({ MessageId: 'message-id' })
      mockArnConfigImplementation('SNS_ARN', 'test-arn')

      const publisher = await createSnsDeploymentPublisherComponent(components)
      await publisher.publishMessage(profileEntity, mockServers)

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            MessageAttributes: expect.objectContaining({
              isMultiplayer: { DataType: 'String', StringValue: 'false' }
            })
          })
        })
      )
    })

    it('should set isMultiplayer to false for scenes without multiplayerId', async () => {
      const singlePlayerEntity = {
        ...mockEntity,
        metadata: { someOtherData: 'value' }
      }

      mockClient.send = jest.fn().mockResolvedValueOnce({ MessageId: 'message-id' })
      mockArnConfigImplementation('EVENTS_SNS_ARN', 'test-arn')

      const publisher = await createSnsEventPublisherComponent(components)
      await publisher.publishMessage(singlePlayerEntity, mockServers)

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            MessageAttributes: expect.objectContaining({
              isMultiplayer: { DataType: 'String', StringValue: 'false' }
            })
          })
        })
      )
    })
  })

  // Helper Functions
  function mockArnConfigImplementation(expectedKey: string, arn: string) {
    configMock.requireString.mockImplementationOnce((key: string) => {
      if (key === expectedKey) return Promise.resolve(arn)
      return Promise.reject(new Error(`Unexpected config key: ${key}`))
    })
  }

  function expectSendToHaveBeenCalledWith(expectedMessage: any, arn: string) {
    expect(mockClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Message: JSON.stringify(expectedMessage),
          TopicArn: arn,
          MessageAttributes: {
            type: { DataType: 'String', StringValue: Events.Type.CATALYST_DEPLOYMENT },
            subType: { DataType: 'String', StringValue: mockEntity.entityType },
            priority: { DataType: 'String', StringValue: '1' },
            isMultiplayer: { DataType: 'String', StringValue: 'false' }
          }
        })
      })
    )
  }
})
