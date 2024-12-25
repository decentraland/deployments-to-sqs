import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { Events } from '@dcl/schemas/dist/platform/events'
import { AppComponents, SnsPublisherComponent, SnsPublishError } from '../../types'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'

export enum SnsType {
  DEPLOYMENT = 'deployment',
  EVENT = 'event'
}

export type SnsOptions = {
  type: SnsType
}

export async function createSnsPublisherComponent(
  components: Pick<AppComponents, 'config' | 'logs'>,
  options: SnsOptions
): Promise<SnsPublisherComponent> {
  const { config, logs } = components

  const endpoint = await config.getString('SNS_ENDPOINT')
  const logger = logs.getLogger('SnsPublisher')

  const client = new SNSClient({
    endpoint: endpoint ?? undefined
  })

  const arnGetter: Record<SnsType, string> = {
    [SnsType.DEPLOYMENT]: await config.requireString('SNS_ARN'),
    [SnsType.EVENT]: await config.requireString('EVENTS_SNS_ARN')
  }

  function getArn(): string {
    return arnGetter[options.type]
  }

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

  function buildDeploymentMessage(entity: DeployableEntity, contentServerUrls: string[]) {
    return messageBuilders[options.type]?.(entity, contentServerUrls) ?? null
  }

  return {
    async publishMessage(entity: DeployableEntity, contentServerUrls: string[]) {
      try {
        const arn = await getArn()
        const message = buildDeploymentMessage(entity, contentServerUrls)

        logger.info(`Publishing message of type ${options.type}`, {
          entityId: entity.entityId,
          entityType: entity.entityType
        })

        const receipt = await client.send(
          new PublishCommand({
            TopicArn: arn,
            Message: JSON.stringify(message),
            MessageAttributes: {
              type: { DataType: 'String', StringValue: Events.Type.CATALYST_DEPLOYMENT },
              subType: { DataType: 'String', StringValue: entity.entityType as Events.SubType.CatalystDeployment }
            }
          })
        )

        logger.info(`Notification of type ${options.type} sent`, {
          messageId: receipt.MessageId as any,
          sequenceNumber: receipt.SequenceNumber as any,
          entityId: entity.entityId,
          entityType: entity.entityType
        })
      } catch (error: any) {
        logger.error('Failed to publish message', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          error: error?.message,
          stack: error?.stack
        })
        throw new SnsPublishError('Failed to publish message', { entity, error })
      }
    }
  }
}
