import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {EventWrapper} from "./EventWrapper"
import {NetworkedSceneObject} from "./NetworkedSceneObject"
import {getPersistenceFromValue} from "./NetworkUtils"
import {SessionController} from "./SessionController"
import {StoreEventWrapper} from "./StoreEventWrapper"

/**
 * Provides information about instantiated prefabs. Exists on a root parent object that instantiated prefabs are spawned underneath.
 */
export class NetworkRootInfo {
  private log = new SyncKitLogger("NetworkRootInfo")

  readonly persistence: RealtimeStoreCreateOptions.Persistence

  /**
   * The instantiated SceneObject. Exists as a child of this SceneObject.
   */
  instantiatedObject: SceneObject

  private _destroyed = false

  /**
   * Event triggered when the instantiated object is destroyed (both locally or remotely)
   */
  onDestroyed: EventWrapper<[]> = new EventWrapper()

  /**
   * Event triggered when the instantiated object is destroyed (both locally or remotely)
   * @deprecated used onDestroyed instead
   */
  onDestroy: EventWrapper<[]> = this.onDestroyed

  /**
   * Event triggered when the instantiated object is destroyed locally
   */
  onLocalDestroyed: EventWrapper<[]> = new EventWrapper()

  /**
   * Event triggered when the instantiated object is destroyed remotely
   */
  onRemoteDestroyed: EventWrapper<[]> = new EventWrapper()

  /**
   * Helper callbacks related to the data store
   */
  callbacks: StoreEventWrapper

  private _scriptHolder: ScriptComponent

  /**
   * @param sceneObject - SceneObject hosting this NetworkRootInfo.
   * @param networkId - Network id of this instantiated object
   * @param dataStore - Store containing information about the prefab instantiation
   * @param locallyCreated - `true` if this instance was instantiated by the current local user in the current session
   * @param ownerInfo - User that owns this instance, or null if unowned
   * @param permissivePersistence - Persistence of the instantiated object
   */
  constructor(
    public readonly sceneObject: SceneObject,
    public readonly networkId: string,
    public readonly dataStore: GeneralDataStore,
    public readonly locallyCreated: boolean,
    public readonly ownerInfo: ConnectedLensModule.UserInfo | null,
    permissivePersistence?: RealtimeStoreCreateOptions.Persistence,
  ) {
    this.persistence = getPersistenceFromValue(permissivePersistence)

    const networkedSceneObject = sceneObject as NetworkedSceneObject

    networkedSceneObject._isNetworkRoot = true
    networkedSceneObject._networkRoot = this

    this.callbacks = new StoreEventWrapper(networkId)

    this.callbacks.onStoreDeleted.add(() => this._onNetworkDestroy())

    this._scriptHolder = this.sceneObject.createComponent(
      "Component.ScriptComponent",
    )

    const destroyEvent = this._scriptHolder.createEvent("OnDestroyEvent")
    destroyEvent.bind(() => this._onLocalDestroy())
  }

  /**
   * Used internally for finishing the NetworkRootInfo setup after the child object has been instantiated
   */
  finishSetup() {
    const child = this.sceneObject.getChild(0)
    this.instantiatedObject = child
    if (this.canIModifyStore()) {
      const scr = child.createComponent("Component.ScriptComponent")
      const sceneObj = this.sceneObject
      scr.createEvent("OnDestroyEvent").bind(() => {
        if (!this._destroyed) {
          this.instantiatedObject = null
          if (child.hasParent()) {
            child.removeParent()
          }
          sceneObj.destroy()
        }
      })
    }
  }

  private _onLocalDestroy() {
    if (!this._destroyed) {
      this._destroyed = true
      if (this.canIModifyStore()) {
        SessionController.getInstance()
          .getSession()
          .deleteRealtimeStore(
            this.dataStore,
            () => {},
            (message) => {
              this.log.e("Error deleting realtime store: " + message)
            },
          )
      }
      this.onLocalDestroyed.trigger()
      this.onDestroyed.trigger()
    }
  }

  private _onNetworkDestroy() {
    if (!this._destroyed) {
      this._destroyed = true
      this.sceneObject.destroy()
      this.onRemoteDestroyed.trigger()
      this.onDestroyed.trigger()
    }
  }

  private _cleanup() {
    this.callbacks.cleanup()
    this.callbacks = null
  }

  /**
   * Returns the owner's userId if an owner exists, otherwise null
   * @returns The owner's userId if an owner exists, otherwise null
   */
  getOwnerUserId(): string | null {
    return this.ownerInfo ? this.ownerInfo.userId : null
  }

  /**
   * Returns the owner's connectionId if an owner exists, otherwise null
   * @returns The owner's connectionId if an owner exists, otherwise null
   */
  getOwnerId(): string | null {
    return this.ownerInfo ? this.ownerInfo.connectionId : null
  }

  /**
   * Returns `true` if the instantiated object is owned by a user with the passed in `connectionId`
   * @param connectionId - connectionId of a user
   * @returns `true` if the instantiated object is owned by a user with the passed in `connectionId`
   */
  isOwnedBy(connectionId: string): boolean {
    return this.getOwnerId() && this.getOwnerId() === connectionId
  }

  /**
   * Returns `true` if the instantiated object is owned by the user connection
   * @param user - userInfo of a user
   * @returns `true` if the instantiated object is owned by the user connection
   */
  isOwnedByUserInfo(user: ConnectedLensModule.UserInfo): boolean {
    return this.getOwnerId() && this.getOwnerId() === user.connectionId
  }

  /**
   * Returns `true` if the local user is allowed to modify this store
   * @returns `true` if the local user is allowed to modify this store
   */
  canIModifyStore(): boolean {
    return (
      !this.getOwnerId() ||
      this.isOwnedByUserInfo(SessionController.getInstance().getLocalUserInfo())
    )
  }

  /**
   * Returns `true` if the local user is allowed to modify this store
   * @returns `true` if the local user is allowed to modify this store
   */
  doIOwnStore(): boolean {
    return this.isOwnedByUserInfo(
      SessionController.getInstance().getLocalUserInfo(),
    )
  }
}
