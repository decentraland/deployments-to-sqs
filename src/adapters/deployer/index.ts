import { IDeployerComponent } from "@dcl/snapshots-fetcher/dist/types"

export function createDeployerComponent(): IDeployerComponent {
  return {
    async deployEntity(entity, servers) {
      if (entity.entityType != "profile") {
        console.log(entity)
      }
    },
    async onIdle() {},
  }
}
