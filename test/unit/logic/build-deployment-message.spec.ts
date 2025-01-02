import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { Events } from '@dcl/schemas/dist/platform/events'
import { buildDeploymentMessage } from '../../../src/logic/build-deployment-message'
import { SnsType } from '../../../src/adapters/sns/types'

describe('buildDeploymentMessage', () => {
  const mockEntity: DeployableEntity = {
    entityId: 'some-id',
    entityType: 'scene',
    pointers: ['pointer1', 'pointer2'],
    authChain: [],
    entityTimestamp: Date.now()
  }

  const mockContentServerUrls = ['https://server1.com', 'https://server2.com']

  it('should build a DeploymentToSqs message for SnsType.DEPLOYMENT', () => {
    const result = buildDeploymentMessage(SnsType.DEPLOYMENT, mockEntity, mockContentServerUrls)

    expect(result).toEqual({
      entity: mockEntity,
      contentServerUrls: mockContentServerUrls
    })
  })

  it('should build a CatalystDeploymentEvent message for SnsType.EVENT', () => {
    const result = buildDeploymentMessage(SnsType.EVENT, mockEntity, mockContentServerUrls)

    expect(result).toEqual({
      type: Events.Type.CATALYST_DEPLOYMENT,
      subType: mockEntity.entityType as Events.SubType.CatalystDeployment,
      entity: mockEntity,
      contentServerUrls: mockContentServerUrls
    })
  })

  it('should throw an error when for an unknown SnsType', () => {
    const unknownType = 'UNKNOWN_TYPE' as SnsType

    expect(() => buildDeploymentMessage(unknownType, mockEntity, mockContentServerUrls)).toThrow(
      `Unknown SnsType: ${unknownType}`
    )
  })

  it('should handle empty contentServerUrls gracefully', () => {
    const result = buildDeploymentMessage(SnsType.DEPLOYMENT, mockEntity, [])

    expect(result).toEqual({
      entity: mockEntity,
      contentServerUrls: []
    })
  })
})
