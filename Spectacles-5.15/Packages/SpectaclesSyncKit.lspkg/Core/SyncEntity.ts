import {Singleton} from "SpectaclesInteractionKit.lspkg/Decorators/Singleton"
import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {EventWrapper} from "./EventWrapper"
import {KeyedEventWrapper} from "./KeyedEventWrapper"
import {NetworkedScriptComponent} from "./NetworkedScriptComponent"
import {generateNetworkId, NetworkIdOptions} from "./NetworkIdTools"
import {NetworkIdType} from "./NetworkIdType"
import {NetworkMessage} from "./NetworkMessage"
import {NetworkMessageWrapper} from "./NetworkMessageWrapper"
import {NetworkRootInfo} from "./NetworkRootInfo"
import {findNetworkRoot, getPersistenceFromValue, putNetworkIdToStore} from "./NetworkUtils"
import {SessionController} from "./SessionController"
import {StorageProperty} from "./StorageProperty"
import {StoragePropertySet} from "./StoragePropertySet"
import {StorageTypes, StorageTypeToPrimitive} from "./StorageTypes"
import {StoreEventWrapper} from "./StoreEventWrapper"

/**
 * Represents an ownership request.
 */
export class OwnershipRequest {
  constructor(
    public readonly onSuccess?: (store: GeneralDataStore) => void,
    public readonly onError?: (error: string) => void
  ) {}
}

/**
 * Helper class used to wrap all event API for a single event name.
 */
export class EntityEventWrapper<T> {
  /**
   * Event triggered when a network event is received.
   */
  onEventReceived: EventWrapper<[NetworkMessage<unknown>]>

  /**
   * Event triggered when a network event is received, but only from remote users.
   */
  onRemoteEventReceived: EventWrapper<[NetworkMessage<unknown>]>

  /**
   * @deprecated
   * Event triggered when a network event is received.
   */
  onAnyEventReceived: EventWrapper<[NetworkMessage<unknown>]>

  constructor(
    private messageWrapper: NetworkMessageWrapper<T>,
    private eventName: string
  ) {
    this.onEventReceived = this.messageWrapper.onAnyEventReceived.getWrapper(this.eventName, true)

    this.onRemoteEventReceived = this.messageWrapper.onRemoteEventReceived.getWrapper(this.eventName, true)

    this.onAnyEventReceived = this.onEventReceived
  }

  /**
   * Send this event.
   * @param data - Optional data object to send
   * @param onlySendRemote - Optional boolean, if true, this event won't be received by the local SyncEntity that sent it
   */
  send(data?: T, onlySendRemote?: boolean) {
    this.messageWrapper.sendMessage(this.eventName, data, onlySendRemote)
  }
}

@Singleton
export class SyncEntityLookup {
  public static getInstance: () => SyncEntityLookup

  globalLookup: Map<string, SyncEntity> = new Map()
}

/**
 * Class acting as a bridge between a ScriptComponent and RealtimeStore.
 */
export class SyncEntity {
  private log = new SyncKitLogger("SyncEntity (No NetworkId)")

  /**
   * The NetworkedScriptComponent this SyncEntity is attached to.
   */
  localScript: NetworkedScriptComponent

  /**
   * Unique NetworkId string used to identify this SyncEntity.
   */
  networkId: string

  /**
   * UserInfo of the SyncEntity's owner, if one exists. Otherwise null.
   */
  ownerInfo: ConnectedLensModule.UserInfo = null

  /**
   * GeneralDataStore created for this SyncEntity and used to store its state. Will be null if the SyncEntity's setup hasn't finished.
   */
  currentStore: GeneralDataStore

  /**
   * Returns the persistence setting for the SyncEntity.
   */
  persistence: RealtimeStoreCreateOptions.Persistence

  /**
   * Provides information about the instantiated Prefab, if this SyncEntity was instantiated. Otherwise, is null.
   */
  networkRoot: NetworkRootInfo = null

  /**
   * Provides direct access to helpful callbacks related to the SyncEntity's `currentStore`.
   */
  storeCallbacks: StoreEventWrapper

  /**
   * Provides direct access to the NetworkMessageWrapper used by SyncEntity events.
   */
  messaging: NetworkMessageWrapper<unknown>

  private _createStoreDelayEvent: DelayedCallbackEvent

  /**
   * The StoragePropertySet used by this SyncEntity. Each StorageProperty in the set will automatically be kept updated.
   */
  propertySet: StoragePropertySet

  /**
   * If `true`, this SyncEntity has been marked as destroyed and should not be interacted with.
   */
  destroyed = false

  /**
   * Event triggered when the SyncEntity's owner changes.
   */
  onOwnerUpdated: EventWrapper<[ConnectedLensModule.UserInfo]> = new EventWrapper()

  /**
   * If `true`, the SyncEntity's setup has finished and it can be fully used.
   */
  isSetupFinished = false

  /**
   * Event triggered with the SyncEntity's setup is finished.
   * It's recommended to use `SyncEntity.notifyOnReady()` instead, since it will call back immediately if setup has already finished.
   */
  onSetupFinished: EventWrapper<[void]> = new EventWrapper()

  /**
   * Event triggered whenever this SyncEntity receives a network event, including ones sent by the local user.
   */
  onEventReceived: KeyedEventWrapper<[NetworkMessage<unknown>]>

  /**
   * Event triggered whenever this SyncEntity receives a network event, but only from remote users.
   */
  onRemoteEventReceived: KeyedEventWrapper<[NetworkMessage<unknown>]>

  /**
   * Event triggered when the SyncEntity is destroyed (both locally or remotely).
   */
  onDestroyed: EventWrapper<[void]> = new EventWrapper()

  /**
   * Event triggered when the SyncEntity is destroyed locally (by the local user).
   */
  onLocalDestroyed: EventWrapper<[void]> = new EventWrapper()

  /**
   * Event triggered when the SyncEntity is destroyed remotely (by another user).
   */
  onRemoteDestroyed: EventWrapper<[void]> = new EventWrapper()

  private _sessionControllerReady = false

  private _ownershipRequests: OwnershipRequest[] = []

  private _syncEntityLookup: SyncEntityLookup = SyncEntityLookup.getInstance()

  constructor(
    scriptComponent: ScriptComponent,
    propertySet?: StoragePropertySet,
    claimOwnership?: boolean,
    persistence?: keyof typeof RealtimeStoreCreateOptions.Persistence | RealtimeStoreCreateOptions.Persistence | null,
    networkIdOptions?: NetworkIdOptions
  ) {
    if (propertySet) {
      this.propertySet = propertySet
    } else {
      this.propertySet = new StoragePropertySet()
    }

    this.localScript = scriptComponent as NetworkedScriptComponent
    if (this.localScript) {
      this.localScript._syncEntity = this
    }

    if (claimOwnership) {
      this._ownershipRequests.push(new OwnershipRequest(null, null))
    }

    const persist = getPersistenceFromValue(persistence)

    this.persistence = persist

    this.networkRoot = null
    if (this.localScript) {
      this.networkRoot = findNetworkRoot(this.localScript.getSceneObject())
    }

    if (!networkIdOptions) {
      if (this.localScript) {
        networkIdOptions = NetworkIdOptions.parseFromScript(this.localScript)
      } else {
        this.log.e("networkIdOptions is required if not using local ScriptComponent")
        return
      }
    }

    this.networkId = generateNetworkId(this.localScript, networkIdOptions, this.networkRoot)
    this.log = new SyncKitLogger(`SyncEntity (${this.networkId})`)

    this.storeCallbacks = new StoreEventWrapper(this.networkId)
    this.messaging = new NetworkMessageWrapper(this.networkId)

    this.onEventReceived = this.messaging.onAnyEventReceived
    this.onRemoteEventReceived = this.messaging.onRemoteEventReceived

    this.storeCallbacks.onStoreCreated.add((multiplayerSession, generalDataStore, userInfo) =>
      this._onRealtimeStoreCreated(multiplayerSession, generalDataStore, userInfo)
    )
    this.storeCallbacks.onStoreUpdated.add((multiplayerSession, generalDataStore, key, realtimeStoreUpdateInfo) =>
      this._onRealtimeStoreUpdated(multiplayerSession, generalDataStore, key, realtimeStoreUpdateInfo)
    )
    this.storeCallbacks.onStoreOwnershipUpdated.add((multiplayerSession, generalDataStore, userInfo) =>
      this._onRealtimeStoreOwnershipUpdated(multiplayerSession, generalDataStore, userInfo)
    )
    this.storeCallbacks.onStoreDeleted.add(() => this._onRealtimeStoreDeleted())

    if (this.localScript) {
      this._createStoreDelayEvent = this.localScript.createEvent("DelayedCallbackEvent")
      this._createStoreDelayEvent.bind(() => this._delayedInitializeStore())
      this.localScript.createEvent("OnDestroyEvent").bind(() => this._onLocalDestroy())

      this.localScript.createEvent("LateUpdateEvent").bind(() => {
        if (this.currentStore) {
          const serverTime = this.getSessionController().getServerTimeInSeconds()
          if (this.isStoreOwned()) {
            if (this.canIModifyStore()) {
              // If we own the store, we only need to send changes
              this.propertySet.sendChanges(this.currentStore, serverTime)
            } else {
              // If someone else owns the store, we only need to receive changes
              this.propertySet.receiveChanges()
            }
          } else {
            // If no-one owns the store, we may need to send and receive changes
            this.propertySet.sendAndReceiveChanges(this.currentStore, serverTime)
          }
        }
      })
    }

    this._syncEntityLookup.globalLookup[this.networkId] = this

    this.getSessionController().notifyOnReady(() => this._onReady())
  }

  /**
   * Creates a new standalone SyncEntity that is not tied to a ScriptComponent.
   * @param networkId - The network ID
   * @param propertySet - Optional set of StorageProperties the SyncEntity will be initialized with
   * @param claimOwnership - Whether to claim ownership
   * @param persistence - The persistence setting
   * @returns The new SyncEntity
   */
  static createStandalone(
    networkId: string,
    propertySet?: StoragePropertySet,
    claimOwnership?: boolean,
    persistence?: (RealtimeStoreCreateOptions.Persistence | keyof typeof RealtimeStoreCreateOptions.Persistence) | null
  ): SyncEntity {
    const idOptions = new NetworkIdOptions(NetworkIdType.Custom, networkId)
    return new SyncEntity(null, propertySet, claimOwnership, persistence, idOptions)
  }

  private _onReady(): void {
    this._sessionControllerReady = true
    const existingStore = this.getSessionController().getStoreInfoById(this.networkId)
    if (existingStore) {
      this.log.d("found existing store already being tracked")
      this._onRealtimeStoreCreated(this.getSession(), existingStore.store, existingStore.ownerInfo)
    } else if (this.networkRoot) {
      if (this.networkRoot.locallyCreated) {
        // We know this was initialized locally, so create store immediately
        this.log.d("found network root, so initialing store immediately")
        this._initializeStore()
      } else {
        this.log.d("found network root, but waiting for remote instantiation")
      }
    } else if (this._createStoreDelayEvent) {
      // Wait for store to be created, then create it ourself
      this._createStoreDelayEvent.reset(0.1)
    } else {
      // Immediately initialize store
      this._initializeStore()
    }
  }

  /**
   * Calls the `onReady` callback as soon as the SyncEntity's setup is completed.
   * If setup is already completed, the callback will be executed immediately.
   * @param onReady - Called as soon as the SyncEntity setup has completed
   */
  notifyOnReady(onReady: () => void): void {
    if (this.isSetupFinished) {
      onReady()
    } else {
      this.onSetupFinished.add(onReady)
    }
  }

  /**
   * Returns the global `SessionController`.
   */
  getSessionController(): SessionController {
    return SessionController.getInstance()
  }

  /**
   * Returns the MultiplayerSession used by the SessionController, if a session exists. Otherwise, returns null.
   * @returns The MultiplayerSession or null
   */
  getSession(): MultiplayerSession | null {
    return this.getSessionController().getSession()
  }

  /**
   * Returns `true` if the local connection is allowed to modify the SyncEntity's data store.
   * This means that setup has finished, and either the SyncEntity is unowned or the local user is the owner.
   * @returns Whether the local connection can modify the store
   */
  canIModifyStore(): boolean {
    return Boolean(
      this.currentStore &&
        (!this.ownerInfo ||
          !this.ownerInfo.connectionId ||
          this.getOwnerId() === this.getSessionController().getLocalConnectionId())
    )
  }

  /**
   * Returns `true` if the local connection owns the SyncEntity's data store.
   * This means that setup has finished, and the local user owns the store.
   * @returns Whether the local connection owns the store
   */
  doIOwnStore(): boolean {
    return Boolean(
      this.currentStore && this.getOwnerId() && this.getOwnerId() === this.getSessionController().getLocalConnectionId()
    )
  }

  /**
   * Returns `true` if setup is finished, and any user owns the SyncEntity's data store.
   * @returns Whether the store is owned
   */
  isStoreOwned(): boolean {
    return Boolean(this.currentStore && this.getOwnerId())
  }

  /**
   * Returns the connectionId string of the SyncEntity's current owner, or null if none exists.
   * @returns The connectionId or null
   */
  getOwnerId(): string | null {
    return this.ownerInfo ? this.ownerInfo.connectionId : null
  }

  /**
   * Returns the userId string of the SyncEntity's current owner, or null if none exists.
   * @returns The userId or null
   */
  getOwnerUserId(): string | null {
    return this.ownerInfo ? this.ownerInfo.userId : null
  }

  /**
   * Returns the connectionId string of the SyncEntity's current owner, or null if none exists.
   * @returns The connectionId or null
   */
  getOwnerConnectionId(): string | null {
    return this.ownerInfo ? this.ownerInfo.connectionId : null
  }

  /**
   * Adds a StorageProperty to the SyncEntity's StoragePropertySet.
   * @param storageProperty - StorageProperty to add
   * @returns The StorageProperty passed in
   */
  addStorageProperty<T extends StorageTypes>(storageProperty: StorageProperty<T>): StorageProperty<T> {
    // Check if key already exists in the dictionary, and use the existing value if so
    if (this.currentStore && this.currentStore.has(storageProperty.key)) {
      const existingValue = StorageProperty.getStoreValueDynamic<StorageTypeToPrimitive[T]>(
        this.currentStore,
        storageProperty.key,
        storageProperty.propertyType
      )
      this.log.d("using existing value for new storage property, " + storageProperty.key + ": " + existingValue)
      storageProperty.silentSetCurrentValue(existingValue)
    }

    this.propertySet.addProperty(storageProperty)
    return storageProperty
  }

  /**
   * Put in an ownership request of this SyncEntity for the local user.
   * The request will be stored if not immediately possible, and try to be honored whenever it becomes possible.
   * If the local user already owns the SyncEntity, `onSuccess` will be called immediately.
   * @param onSuccess - Called as soon as ownership was successfully gained
   * @param onError - Called if an error occurs
   */
  tryClaimOwnership(onSuccess?: (store: GeneralDataStore) => void, onError?: (error: string) => void): void {
    if (this.currentStore) {
      if (this.doIOwnStore()) {
        if (onSuccess) {
          onSuccess(this.currentStore)
        }
      } else if (this.isStoreOwned()) {
        this.log.d("Wait for ownership to be released before claiming it")
        this._ownershipRequests.push(new OwnershipRequest(onSuccess, onError))
      } else {
        onSuccess = onSuccess || (() => {})
        onError =
          onError ||
          ((error: string) => {
            this.log.d(error)
          })
        this.getSession().requestRealtimeStoreOwnership(this.currentStore, onSuccess, onError)
      }
    } else {
      this.log.d("Trying to claim ownership before store exists!")
      this._ownershipRequests.push(new OwnershipRequest(onSuccess, onError))
    }
  }

  /**
   * Try to revoke ownership if the local user owns this SyncEntity, otherwise `onSuccess` is called immediately.
   * @param onSuccess - Called if the ownership was revoked successfully
   * @param onError - Called if an error occurs
   */
  tryRevokeOwnership(onSuccess?: (store: GeneralDataStore) => void, onError?: (error: string) => void): void {
    if (this.currentStore) {
      if (!this.doIOwnStore()) {
        if (onSuccess) {
          onSuccess(this.currentStore)
        }
      } else {
        onSuccess = onSuccess || (() => {})
        onError =
          onError ||
          ((error: string) => {
            this.log.d(error)
          })
        this.getSession().clearRealtimeStoreOwnership(this.currentStore, onSuccess, onError)
      }
    } else {
      this.log.e("Trying to revoke ownership before store exists!")
    }
  }

  /**
   * Put in an ownership request of this SyncEntity for the local user.
   * If the local user already owns the SyncEntity, `onSuccess` will be called immediately.
   * @param onSuccess - Called as soon as ownership was successfully gained
   * @param onError - Called if an error occurs
   */
  requestOwnership(onSuccess?: (store: GeneralDataStore) => void, onError?: (error: string) => void): void {
    if (this.currentStore) {
      if (this.doIOwnStore()) {
        if (onSuccess) {
          onSuccess(this.currentStore)
        }
      } else {
        onSuccess = onSuccess || (() => {})
        onError =
          onError ||
          ((error: string) => {
            this.log.d(error)
          })
        /*
          The requestRealtimeStoreOwnership onSuccess callback is called before the onRealTimeStoreOwnershipUpdated callback, 
          causing a race condition between when the ownership is updated and when the onSuccess callback is executed.
          Instead of relying on the onSuccess callback, we instead delegate the onSuccess of requestOwnership to the onStoreOwnershipUpdated event
          this ensures updates are synchronised between internal state of MultiplayerSession and SyncEntity.
         */
        this.getSession().requestRealtimeStoreOwnership(
          this.currentStore,
          () => {
            if (this.destroyed || !this.storeCallbacks) {
              return
            }
            const onSuccessCallback = (_: MultiplayerSession, generalDataStore: GeneralDataStore) => {
              // Execute only once, then remove event listener
              this.storeCallbacks?.onStoreOwnershipUpdated.remove(onSuccessCallback)
              onSuccess(generalDataStore)
            }

            // onStoreOwnershipUpdated ensures that we execute onSuccess *only* after ownership is updated.
            this.storeCallbacks.onStoreOwnershipUpdated.add(onSuccessCallback)
          },
          onError
        )
      }
    } else {
      onError =
        onError ||
        ((error: string) => {
          this.log.d(error)
        })
      onError(
        "Trying to request ownership before the store exists. Please wait until the SyncEntity setup is finished."
      )
    }
  }

  /**
   * Destroys the SyncEntity. If attached to a ScriptComponent, the SceneObject will also be destroyed.
   */
  destroy(): void {
    if (this.localScript) {
      this.localScript.getSceneObject().destroy()
    } else {
      this._onLocalDestroy()
    }
  }

  private _delayedInitializeStore() {
    this.log.d("initializing the store, after delay")
    this._initializeStore()
  }

  private _initializeStore() {
    this._cleanupStoreDelayEvent()

    this.log.d("initializing store for " + this.networkId)

    const storeData = GeneralDataStore.create()
    putNetworkIdToStore(storeData, this.networkId)
    this.propertySet.forceWriteState(storeData)
    this.propertySet.receiveChanges()

    const storeOptions = RealtimeStoreCreateOptions.create()
    storeOptions.initialStore = storeData
    storeOptions.ownership = RealtimeStoreCreateOptions.Ownership.Unowned
    storeOptions.persistence = this.persistence

    let startOwned = false

    if (this._ownershipRequests.length > 0) {
      this.log.d("found ownership requests, we should start owned")
      startOwned = true
    } else {
      this.log.d("no ownership requests " + this._ownershipRequests)
    }

    if (startOwned) {
      this.log.d("requesting ownership for the store")
      storeOptions.ownership = RealtimeStoreCreateOptions.Ownership.Owned
      this.ownerInfo = this.getSessionController().getLocalUserInfo()
      // this.onOwnerUpdated.trigger(this.ownerInfo);
    }

    const session = this.getSession()
    session.createRealtimeStore(
      storeOptions,
      () => {
        if (!this.destroyed) {
          if (startOwned) {
            this.onOwnerUpdated.trigger(this.ownerInfo)
          }
          if (!this.currentStore) {
            /*
             * This hasn't been necessary, we are handling the callback in _onRealtimeStoreCreated
             * me.currentStore = store;
             */
          }
        }
      },
      (error: string) => {
        this.log.e(error)
      }
    )
  }

  private _resolveOwnershipRequests() {
    if (this.doIOwnStore()) {
      for (let i = 0; i < this._ownershipRequests.length; i++) {
        if (this._ownershipRequests[i].onSuccess) {
          this._ownershipRequests[i].onSuccess(this.currentStore)
        }
      }
      this._ownershipRequests = []
    }
  }

  /**
   * @param _session - The multiplayer session
   * @param store - The general data store
   * @param userInfo - The user info
   */
  private _onRealtimeStoreCreated(
    _session: MultiplayerSession,
    store: GeneralDataStore,
    userInfo: ConnectedLensModule.UserInfo
  ) {
    if (!this.currentStore && this._sessionControllerReady) {
      if (this.destroyed) {
        this.log.e("Got realtime store creation for entity that was already destroyed")
        return
      }
      this.log.d("found matching store for id " + this.networkId)
      this._cleanupStoreDelayEvent()
      this.currentStore = store
      this.ownerInfo = userInfo
      this.log.d("realtime store created, store owner: " + userInfo.connectionId + " " + userInfo.displayName)

      if (this.doIOwnStore()) {
        // If we own the store, update the store with our current data
        this.propertySet.forceWriteState(store)
        this._resolveOwnershipRequests()
      } else {
        // If we don't own the store, update our data with the store data
        this.propertySet.initializeFromStore(store)
      }

      this.onOwnerUpdated.trigger(this.ownerInfo)

      if (this._ownershipRequests.length > 0 && !this.isStoreOwned()) {
        this.tryClaimOwnership()
      }

      this.isSetupFinished = true
      this.onSetupFinished.trigger()
    }
  }

  /**
   * @param _session - The multiplayer session
   * @param store - The general data store
   * @param key - The key
   * @param updateInfo - The update info
   */
  private _onRealtimeStoreUpdated(
    _session: MultiplayerSession,
    store: GeneralDataStore,
    key: string,
    updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo
  ) {
    // If we own the store, assume that this is an update we made and can be ignored
    if (!this.doIOwnStore()) {
      // If we originally sent the update, ignore it
      if (
        !updateInfo ||
        !updateInfo.updaterInfo ||
        updateInfo.updaterInfo.connectionId !== this.getSessionController().getLocalConnectionId()
      ) {
        this.propertySet.applyKeyUpdate(store, key, false, false, updateInfo)
      }
    }
  }

  private _onRealtimeStoreDeleted() {
    this._onRemoteDestroy()
  }

  /**
   * @param _session - The multiplayer session
   * @param _store - The general data store
   * @param owner - The owner info
   */
  private _onRealtimeStoreOwnershipUpdated(
    _session: MultiplayerSession,
    _store: GeneralDataStore,
    owner: ConnectedLensModule.UserInfo
  ) {
    this.ownerInfo = owner
    if (this.doIOwnStore()) {
      this._resolveOwnershipRequests()
    } else if (!this.isStoreOwned()) {
      if (this._ownershipRequests.length > 0) {
        this.tryClaimOwnership()
      }
    }
    this.onOwnerUpdated.trigger(this.ownerInfo)
  }

  /**
   * Send a network event to all copies of this SyncEntity.
   * @param eventName - Name identifying the event
   * @param eventData - Optional object of any data type that can be included with the event
   * @param onlySendRemote - If true, this event won't be received by the local SyncEntity that sent it
   */
  sendEvent(eventName: string, eventData?: unknown, onlySendRemote?: boolean) {
    if (this.isSetupFinished) {
      this.messaging.sendMessage(eventName, eventData, onlySendRemote)
    } else {
      this.log.e(
        "Trying to send an event before setup is finished: " +
          eventName +
          "\nTODO: Queue these messages and send when setup finished."
      )
    }
  }

  /**
   * Creates and returns an {@link EntityEventWrapper}, which is a helper for dealing with network events.
   * @param eventName - Name of the network event to wrap
   * @returns New {@link EntityEventWrapper} wrapping the event
   */
  getEntityEventWrapper<T>(eventName: string): EntityEventWrapper<T> {
    return new EntityEventWrapper<T>(this.messaging as NetworkMessageWrapper<T>, eventName)
  }

  private _onLocalDestroy() {
    if (!this.destroyed) {
      this.log.d("on local destroy")
      this.destroyed = true
      this._cleanup()
      if (this.canIModifyStore()) {
        this.log.d("requesting store deletion")
        this.getSession().deleteRealtimeStore(
          this.currentStore,
          () => this.log.d("deleted store"),
          (error) => this.log.e(error)
        )
      }
      this.onLocalDestroyed.trigger()
      this.onDestroyed.trigger()
    }
  }

  private _onRemoteDestroy() {
    if (!this.destroyed) {
      this.destroyed = true
      this._cleanup()
      if (!isNull(this.localScript)) {
        if (!isNull(this.localScript.getSceneObject())) {
          this.log.d("destroying local SceneObject")
          this.localScript.getSceneObject().destroy()
        }
        this.onRemoteDestroyed.trigger()
        this.onDestroyed.trigger()
      }
    }
  }

  private _cleanupStoreDelayEvent() {
    if (this._createStoreDelayEvent) {
      if (this.localScript) {
        this.localScript.removeEvent(this._createStoreDelayEvent)
      }
      this._createStoreDelayEvent = null
    }
  }

  private _cleanup() {
    this.storeCallbacks.cleanup()
    this.storeCallbacks = null
    this.messaging.cleanup()
    this.messaging = null
    this.onOwnerUpdated = null
    delete this._syncEntityLookup.globalLookup[this.networkId]
    this._cleanupStoreDelayEvent()
  }

  /**
   * Returns a SyncEntity stored on the `component` if one exists, otherwise null.
   * @param component - Component to check
   * @returns SyncEntity found on `component`, or null
   */
  static getSyncEntityOnComponent(component: Component): SyncEntity | null {
    const networkedScriptComponent = component as NetworkedScriptComponent
    return networkedScriptComponent._syncEntity || null
  }

  /**
   * Returns the first SyncEntity found on a component attached to `sceneObject`, or null if none is found.
   * @param sceneObject - SceneObject to check
   * @returns SyncEntity found on `sceneObject`, or null
   */
  static getSyncEntityOnSceneObject(sceneObject: SceneObject): SyncEntity | null {
    const components = sceneObject.getComponents("ScriptComponent")
    let syncEntity: SyncEntity | null = null
    for (let i = 0; i < components.length; i++) {
      syncEntity = SyncEntity.getSyncEntityOnComponent(components[i])
      if (syncEntity !== null) {
        return syncEntity
      }
    }
    return null
  }

  /**
   * Returns a SyncEntity with matching network id, or null if none exists.
   * @param networkId - The network ID
   * @returns SyncEntity with matching network ID, or null
   */
  static findById(networkId: string): SyncEntity | null {
    return SyncEntityLookup.getInstance().globalLookup[networkId] || null
  }
}

// Export SyncEntity globally
;(global as any).SyncEntity = SyncEntity
