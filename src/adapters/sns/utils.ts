import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { SnsType } from './types'
import { Events } from '@dcl/schemas/dist/platform/events'

const messageBuilders: Record<SnsType, (entity: DeployableEntity, contentServerUrls: string[]) => any> = {
  [SnsType.DEPLOYMENT]: buildDeploymentToSqsMessage,
  [SnsType.EVENT]: buildCatalystDeploymentEventMessage
}

function buildDeploymentToSqsMessage(entity: DeployableEntity, contentServerUrls: string[]): DeploymentToSqs {
  return {
    entity,
    contentServerUrls
  }
}

function buildCatalystDeploymentEventMessage(entity: DeployableEntity, contentServerUrls: string[]) {
  // TODO: this should be a CatalystDeploymentEvent
  return {
    type: Events.Type.CATALYST_DEPLOYMENT,
    subType: entity.entityType as Events.SubType.CatalystDeployment,
    entity,
    contentServerUrls
  }
}

export function buildDeploymentMessage(type: SnsType, entity: DeployableEntity, contentServerUrls: string[]) {
  return messageBuilders[type]?.(entity, contentServerUrls) ?? null
}
