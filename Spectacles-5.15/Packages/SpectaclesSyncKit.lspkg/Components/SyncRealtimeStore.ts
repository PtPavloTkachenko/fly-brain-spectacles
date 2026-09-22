import {NetworkIdOptions} from "../Core/NetworkIdTools"
import {networkIdFromString, NetworkIdType} from "../Core/NetworkIdType"
import {StorageProperty} from "../Core/StorageProperty"
import { StorageTypes } from "../Core/StorageTypes"
import {SyncEntity} from "../Core/SyncEntity"

/**
 * Meant to be a very simple interface for a synced entity and its RealtimeStore.
 * It doesn’t do any behaviors on its own, so it can be used just for storing and retrieving synced values.
 */
@component
export class SyncRealtimeStore extends BaseScriptComponent {
  @input("string", "objectId")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Object Id", "objectId"),
      new ComboBoxItem("Custom", "custom"),
    ])
  )
  @label("Network Id Type")
  private readonly networkIdTypeString: string = "objectId"
  private readonly networkIdType: NetworkIdType = networkIdFromString(
    this.networkIdTypeString
  )

  @input("string", "enter_unique_id")
  @showIf("networkIdTypeString", "custom")
  private readonly customNetworkId: string = "enter_unique_id"

  @input("string", "none")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "none"),
      new ComboBoxItem("Request if Available", "requestIfAvailable"),
    ])
  )
  @label("Ownership Type")
  private readonly ownershipTypeString: string = "none"
  private readonly shouldRequestOwnership =
    this.ownershipTypeString === "requestIfAvailable"

  readonly syncEntity: SyncEntity = new SyncEntity(
    this,
    null,
    this.shouldRequestOwnership,
    null,
    new NetworkIdOptions(this.networkIdType, this.customNetworkId)
  )

  onStoreCreated = this.syncEntity.storeCallbacks.onStoreCreated
  onStoreUpdated = this.syncEntity.storeCallbacks.onStoreUpdated
  onStoreOwnershipUpdated =
    this.syncEntity.storeCallbacks.onStoreOwnershipUpdated
  onStoreDeleted = this.syncEntity.storeCallbacks.onStoreDeleted
  onSetupFinished = this.syncEntity.onSetupFinished
  onOwnerUpdated = this.syncEntity.onOwnerUpdated

  /**
   * @returns True if the store is ready
   */
  isStoreReady(): boolean {
    return this.syncEntity.isSetupFinished
  }

  /**
   * @returns The data store backing this entity
   */
  getStore(): GeneralDataStore | null {
    return this.syncEntity.currentStore
  }

  /**
   * @returns The store owner's user info
   */
  getStoreOwnerInfo(): ConnectedLensModule.UserInfo | null {
    return this.syncEntity.ownerInfo
  }

  /**
   * @returns True if the current user can modify the store
   */
  canIModifyStore(): boolean {
    return this.syncEntity.canIModifyStore()
  }

  /**
   * @returns True if the store is owned by the current user
   */
  doIOwnStore(): boolean {
    return this.syncEntity.doIOwnStore()
  }

  /**
   * @returns True if the store is owned by any user
   */
  isStoreOwned(): boolean {
    return this.syncEntity.isStoreOwned()
  }

  /**
   * @param storageProperty - The storage property to add to the entity
   * @returns The storage property that was added
   */
  addStorageProperty<T extends StorageTypes>(
    storageProperty: StorageProperty<T>
  ): StorageProperty<T> {
    return this.syncEntity.addStorageProperty(storageProperty)
  }
}
