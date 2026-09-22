import {EventWrapper} from "./EventWrapper"
import {getNetworkIdFromStore, NetworkIdFilter} from "./NetworkUtils"
import {SessionController} from "./SessionController"

export class StoreEventWrapper {
  private _cleanups: Array<() => void> = []

  onStoreCreated: EventWrapper<
    [
      session: MultiplayerSession,
      store: GeneralDataStore,
      ownerInfo: ConnectedLensModule.UserInfo,
      creationInfo: ConnectedLensModule.RealtimeStoreCreationInfo
    ]
  >

  onStoreUpdated: EventWrapper<
    [
      session: MultiplayerSession,
      store: GeneralDataStore,
      key: string,
      updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo
    ]
  >

  onStoreOwnershipUpdated: EventWrapper<
    [
      session: MultiplayerSession,
      store: GeneralDataStore,
      ownerInfo: ConnectedLensModule.UserInfo,
      ownershipUpdateInfo: ConnectedLensModule.RealtimeStoreOwnershipUpdateInfo
    ]
  >

  onStoreDeleted: EventWrapper<
    [session: MultiplayerSession, store: GeneralDataStore, deleteInfo: ConnectedLensModule.RealtimeStoreDeleteInfo]
  >

  onStoreKeyRemoved: EventWrapper<
    [session: MultiplayerSession, store: GeneralDataStore, removalInfo: ConnectedLensModule.RealtimeStoreKeyRemovalInfo]
  >

  idFilter: NetworkIdFilter

  /**
   * Initializes a new instance of the `StoreEventWrapper` class.
   * @param networkId - The network ID.
   */
  constructor(public networkId: string) {
    this.idFilter = this.makeNetworkIdFilter(networkId)

    this.onStoreCreated = this.wrapStoreEventWithFilter(
      SessionController.getInstance().onRealtimeStoreCreated,
      this.idFilter,
      this._cleanups
    )

    this.onStoreUpdated = this.wrapStoreEventWithFilter(
      SessionController.getInstance().onRealtimeStoreUpdated,
      this.idFilter,
      this._cleanups
    )

    this.onStoreOwnershipUpdated = this.wrapStoreEventWithFilter(
      SessionController.getInstance().onRealtimeStoreOwnershipUpdated,
      this.idFilter,
      this._cleanups
    )

    this.onStoreDeleted = this.wrapStoreEventWithFilter(
      SessionController.getInstance().onRealtimeStoreDeleted,
      this.idFilter,
      this._cleanups
    )

    this.onStoreKeyRemoved = this.wrapStoreEventWithFilter(
      SessionController.getInstance().onRealtimeStoreKeyRemoved,
      this.idFilter,
      this._cleanups
    )
  }

  cleanup() {
    for (let i = 0; i < this._cleanups.length; i++) {
      this._cleanups[i]()
    }
    this._cleanups = []
  }

  /**
   * Wraps a store event with a filter function.
   * @param event - The event to wrap.
   * @param filterFunc - The filter function.
   * @param cleanupFuncs - Optional array of cleanup functions.
   * @returns The wrapped event.
   */
  wrapStoreEventWithFilter<T extends unknown[]>(
    event: EventWrapper<T>,
    filterFunc: (store: unknown) => boolean,
    cleanupFuncs: Array<() => void> | null
  ): EventWrapper<T> {
    const evt: EventWrapper<T> = new EventWrapper()
    const callback = (...args: T) => {
      if (filterFunc(args[1])) {
        evt.trigger(...args)
      }
    }
    event.add(callback)
    if (cleanupFuncs) {
      cleanupFuncs.push(() => {
        event.remove(callback)
      })
    }
    return evt
  }

  /**
   * Creates a network ID filter function.
   * @param networkId - The network ID.
   * @returns The filter function.
   */
  makeNetworkIdFilter(networkId: string): NetworkIdFilter {
    return (store) => {
      return getNetworkIdFromStore(store) === networkId
    }
  }
}
