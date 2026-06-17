import { Events } from '@dcl/schemas/dist/platform/events'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createSnsComponent, IPublisherComponent, PublishableEvent } from '@dcl/sns-component'
import { DeployableEntity } from '@dcl/snapshots-fetcher/dist/types'
import { AppComponents, SnsPublisherComponent, SnsPublishError } from '../../types'
import { SnsOptions, SnsType } from './types'
import { buildDeploymentMessage } from '../../logic/build-deployment-message'

// Which env var holds the topic ARN for each publisher. The core
// @dcl/sns-component reads a single `AWS_SNS_ARN`, so we surface the right one
// per instance via the remapped config below.
const ARN_CONFIG_KEY: Record<SnsType, string> = {
  [SnsType.DEPLOYMENT]: 'SNS_ARN',
  [SnsType.EVENT]: 'EVENTS_SNS_ARN'
}

/**
 * Wraps a config component so the keys the core @dcl/sns-component reads
 * (`AWS_SNS_ARN`, `AWS_SNS_ENDPOINT`) resolve to this service's own env vars.
 *
 * This service publishes to two different SNS topics (deployment + event), but
 * the component only knows about a single `AWS_SNS_ARN`. Rather than fork or
 * extend the component, each publisher is handed a thin config that maps
 * `AWS_SNS_ARN` to its topic's env var (`SNS_ARN` / `EVENTS_SNS_ARN`) and
 * `AWS_SNS_ENDPOINT` to our `SNS_ENDPOINT`. Keys not in the map (e.g.
 * `AWS_REGION`, already shared) fall through to the underlying config unchanged.
 *
 * @param config - The underlying config component.
 * @param keyMap - Maps the keys the component reads to this service's keys.
 * @returns A config component that transparently remaps the mapped keys.
 */
function createRemappedConfig(config: IConfigComponent, keyMap: Record<string, string>): IConfigComponent {
  const resolve = (name: string): string => keyMap[name] ?? name
  return {
    getString: (name: string) => config.getString(resolve(name)),
    getNumber: (name: string) => config.getNumber(resolve(name)),
    requireString: (name: string) => config.requireString(resolve(name)),
    requireNumber: (name: string) => config.requireNumber(resolve(name))
  }
}

async function createSnsPublisherComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>,
  options: SnsOptions
): Promise<SnsPublisherComponent> {
  const { config, logs, metrics } = components

  const logger = logs.getLogger('SnsPublisher')

  const snsConfig = createRemappedConfig(config, {
    AWS_SNS_ARN: ARN_CONFIG_KEY[options.type],
    AWS_SNS_ENDPOINT: 'SNS_ENDPOINT'
  })

  const publisher: IPublisherComponent = await createSnsComponent({ config: snsConfig })

  return {
    async publishMessage(entity: DeployableEntity & { metadata: any }, contentServerUrls: string[]) {
      try {
        const message = buildDeploymentMessage(options.type, entity, contentServerUrls)

        // The core publisher derives the `type`/`subType` SNS message attributes
        // (consumed by subscription filter policies) from the event body, so both
        // topics must carry them. The event message already includes them; for the
        // deployment message this adds `type`/`subType` to the published body —
        // safe because DeploymentToSqs allows additional properties.
        const event: PublishableEvent = {
          type: Events.Type.CATALYST_DEPLOYMENT,
          subType: entity.entityType as Events.SubType.CatalystDeployment,
          ...message
        }

        logger.info(`Publishing message of type ${options.type}`, {
          entityId: entity.entityId,
          entityType: entity.entityType
        })

        const isMultiplayerScene = entity.entityType === 'scene' && !!entity.metadata?.multiplayerId

        const receipt = await publisher.publishMessage(event, {
          priority: { DataType: 'String', StringValue: '1' },
          isMultiplayer: { DataType: 'String', StringValue: isMultiplayerScene ? 'true' : 'false' }
        })

        logger.info(`Notification of type ${options.type} sent`, {
          messageId: receipt.MessageId as any,
          sequenceNumber: receipt.SequenceNumber as any,
          entityId: entity.entityId,
          entityType: entity.entityType,
          isMultiplayerScene: isMultiplayerScene ? 'true' : 'false'
        })

        metrics.increment('sns_publish_success', { type: options.type })
      } catch (error: any) {
        logger.error('Failed to publish message', {
          entityId: entity.entityId,
          entityType: entity.entityType,
          error: error?.message,
          stack: error?.stack
        })
        metrics.increment('sns_publish_failure', { type: options.type })

        throw new SnsPublishError('Failed to publish message', { entity, error })
      }
    }
  }
}

export async function createSnsDeploymentPublisherComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>
): Promise<SnsPublisherComponent> {
  return createSnsPublisherComponent(components, { type: SnsType.DEPLOYMENT })
}

export async function createSnsEventPublisherComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>
): Promise<SnsPublisherComponent> {
  return createSnsPublisherComponent(components, { type: SnsType.EVENT })
}
