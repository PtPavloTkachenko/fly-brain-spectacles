import {Instantiator} from "../Components/Instantiator"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

@component
export class InstantiatorExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    InstantiatorExample.name
  )

  @input()
  instantiator: Instantiator

  @input()
  prefab: ObjectPrefab

  onAwake(): void {
    this.instantiator.notifyOnReady(() => {
      this.onReady()
    })
  }

  onReady(): void {
    this.log.i("Example Component: The instantiator is ready!")
    this.instantiator.instantiate(this.prefab)
  }
}
