import { EntityType } from '@dcl/schemas/dist/platform/entity'
import { OTHER_ENTITY_TYPE, toEntityTypeLabel } from '../../../src/logic/entity-type-label'

describe('toEntityTypeLabel', () => {
  describe('when the entity type is one Decentraland deploys', () => {
    it.each(Object.values(EntityType))('should pass "%s" through unchanged', (entityType) => {
      expect(toEntityTypeLabel(entityType)).toBe(entityType)
    })
  })

  describe('and the entity type is an unrecognised string from a content server', () => {
    let label: string

    beforeEach(() => {
      label = toEntityTypeLabel('something-a-catalyst-made-up')
    })

    it('should collapse it to the shared bucket', () => {
      expect(label).toBe(OTHER_ENTITY_TYPE)
    })
  })

  describe('and many distinct unrecognised values arrive', () => {
    let labels: Set<string>

    beforeEach(() => {
      labels = new Set(Array.from({ length: 1000 }, (_, i) => toEntityTypeLabel(`attacker-${i}`)))
    })

    it('should keep the label cardinality at one, which is the whole point of the clamp', () => {
      expect(labels).toEqual(new Set([OTHER_ENTITY_TYPE]))
    })
  })

  describe('and the entity type is not a string at all', () => {
    it.each([[undefined], [null], [42], [{}], [[]]])('should collapse %p to the shared bucket', (entityType) => {
      expect(toEntityTypeLabel(entityType)).toBe(OTHER_ENTITY_TYPE)
    })
  })

  describe('and the entity type differs only by case from a known one', () => {
    it('should not treat it as known, since Prometheus labels are case sensitive', () => {
      expect(toEntityTypeLabel('Scene')).toBe(OTHER_ENTITY_TYPE)
    })
  })
})
