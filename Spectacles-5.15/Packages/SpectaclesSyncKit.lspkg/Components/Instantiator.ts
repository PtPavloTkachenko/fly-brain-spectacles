import {NetworkRootInfo} from "../Core/NetworkRootInfo"
import {
  getNetworkIdFromStore,
  getNetworkTypeFromStore,
  getPersistenceFromValue,
  putNetworkIdToStore,
  putNetworkTypeToStore,
} from "../Core/NetworkUtils"
import {persistenceTypeFromString} from "../Core/PersistenceType"
import {SessionController} from "../Core/SessionController"
import {SyncEntity} from "../Core/SyncEntity"
import {isNullOrUndefined} from "../Utils/Helpers"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

export type InstantiationOptionsObj = {
  onSuccess?: (networkRoot: NetworkRootInfo) => void
  persistence?:
    | RealtimeStoreCreateOptions.Persistence
    | keyof typeof RealtimeStoreCreateOptions.Persistence
  claimOwnership?: boolean
  worldPosition?: vec3
  worldRotation?: quat
  worldScale?: vec3
  localPosition?: vec3
  localRotation?: quat
  localScale?: vec3
  onError?: (message: string) => void
  overrideNetworkId?: string
  customDataStore?: GeneralDataStore
}

export class InstantiationOptions {
  onSuccess: ((networkRoot: NetworkRootInfo) => void) | null
  persistence:
    | RealtimeStoreCreateOptions.Persistence
    | keyof typeof RealtimeStoreCreateOptions.Persistence
    | null
  claimOwnership: boolean | null
  worldPosition: vec3 | null
  worldRotation: quat | null
  worldScale: vec3 | null
  localPosition: vec3 | null
  localRotation: quat | null
  localScale: vec3 | null
  onError: ((message: string) => void) | null
  overrideNetworkId: string | null
  customDataStore: GeneralDataStore | null

  constructor(optionDic?: InstantiationOptionsObj) {
    this.onSuccess = optionDic?.onSuccess ?? null
    this.persistence = optionDic?.persistence ?? null
    this.claimOwnership = optionDic?.claimOwnership ?? null
    this.worldPosition = optionDic?.worldPosition ?? null
    this.worldRotation = optionDic?.worldRotation ?? null
    this.worldScale = optionDic?.worldScale ?? null
    this.localPosition = optionDic?.localPosition ?? null
    this.localRotation = optionDic?.localRotation ?? null
    this.localScale = optionDic?.localScale ?? null
    this.onError = optionDic?.onError ?? null
    this.overrideNetworkId = optionDic?.overrideNetworkId ?? null
    this.customDataStore = optionDic?.customDataStore ?? null
  }
}

const SPAWNER_ID_KEY = "_spawner_id"
const PREFAB_ID_KEY = "_prefab_name"
const START_POS_KEY = "_init_pos"
const START_ROT_KEY = "_init_rot"
const START_SCALE_KEY = "_init_scale"

const TAG = "Instantiator"

/**
 * Used to instantiate prefabs across the network.
 * Prefabs must be added to the prefabs list or autoInstantiate list in order to be instantiated.
 */
@component
export class Instantiator extends BaseScriptComponent {
  @input
  private prefabs: ObjectPrefab[] = []

  @input("boolean", "false")
  private spawnerOwnsObject = false

  @input("boolean", "false")
  private spawnAsChildren = false

  @input
  @showIf("spawnAsChildren")
  private spawnUnderParent: SceneObject | null = null

  @ui.separator
  @input("boolean", "false")
  private autoInstantiate = false

  @input
  @label("Prefabs")
  @showIf("autoInstantiate")
  private autoInstantiatePrefabs: ObjectPrefab[] = []

  @input("string", "Session")
  @label("Persistence")
  @showIf("autoInstantiate")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Ephemeral", "Ephemeral"),
      new ComboBoxItem("Owner", "Owner"),
      new ComboBoxItem("Session", "Session"),
      new ComboBoxItem("Persist", "Persist"),
    ]),
  )
  private persistenceString = "Session"
  private persistence: RealtimeStoreCreateOptions.Persistence =
    persistenceTypeFromString(this.persistenceString)

  @input("string", "Unowned")
  @showIf("autoInstantiate")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Owned", "Owned"),
      new ComboBoxItem("Unowned", "Unowned"),
    ]),
  )
  @label("Auto Instantiate Ownership")
  private autoInstantiateOwnershipString = "Unowned"
  private autoInstantiateOwnership: RealtimeStoreCreateOptions.Ownership =
    this.autoInstantiateOwnershipString === "Owned"
      ? RealtimeStoreCreateOptions.Ownership.Owned
      : RealtimeStoreCreateOptions.Ownership.Unowned

  private spawnedInstances: Map<string, NetworkRootInfo> = new Map()

  private spawningInstances: Map<string, SceneObject> = new Map()

  private syncEntity = new SyncEntity(this)

  private log = new SyncKitLogger(TAG)

  private onAwake(): void {
    SessionController.getInstance().notifyOnReady(() => this.onReady())
    SessionController.getInstance().onRealtimeStoreCreated.add(
      (session, datastore, userInfo) =>
        this.onRealtimeStoreCreated(session, datastore, userInfo),
    )
    this.createEvent("OnEnableEvent").bind(() =>
      this.spawnInitialInstancesOnReady(),
    )
  }

  /**
   * Generates a unique network ID for the prefab.
   * @param prefab - The prefab to generate the ID for.
   * @param options - The instantiation options.
   * @returns The generated network ID.
   */
  private generatePrefabId(
    prefab: ObjectPrefab,
    options: InstantiationOptions | InstantiationOptionsObj,
  ): string {
    if (
      !isNullOrUndefined(options) &&
      !isNullOrUndefined(options?.overrideNetworkId)
    ) {
      return options.overrideNetworkId
    } else {
      return (
        prefab.name +
        "_" +
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15)
      )
    }
  }

  /**
   * Finds a prefab by its name.
   * @param prefabName - The name of the prefab.
   * @returns The found prefab, or null if not found.
   */
  private findPrefabByName(prefabName: string): ObjectPrefab | null {
    for (let i = 0; i < this.prefabs.length; i++) {
      if (this.prefabs[i].name === prefabName) {
        return this.prefabs[i]
      }
    }
    for (let i = 0; i < this.autoInstantiatePrefabs.length; i++) {
      if (this.autoInstantiatePrefabs[i].name === prefabName) {
        return this.autoInstantiatePrefabs[i]
      }
    }
    return null
  }

  /**
   * Instantiates a new prefab.
   * @param networkId - The network ID of the prefab.
   * @param prefab - The prefab to instantiate.
   * @param options - The instantiation options.
   */
  private instantiateNewPrefab(
    networkId: string,
    prefab: ObjectPrefab,
    options: (InstantiationOptions | InstantiationOptionsObj) | null,
  ) {
    options = options || {}
    this.log.d("instantiate new prefab with id " + networkId)
    const prefabName = prefab.name
    const rootObj = global.scene.createSceneObject("holder:" + networkId)

    const parentObj =
      this.spawnAsChildren && (this.spawnUnderParent || this.getSceneObject())

    if (parentObj) {
      rootObj.setParent(parentObj)
    }

    const initialData = options.customDataStore || GeneralDataStore.create()

    putNetworkIdToStore(initialData, networkId)
    putNetworkTypeToStore(initialData, "prefab")
    initialData.putString(PREFAB_ID_KEY, prefabName)
    this.setSpawnerIdOnStore(initialData, this.syncEntity.networkId)

    if (options.worldPosition) {
      rootObj.getTransform().setWorldPosition(options.worldPosition)
      initialData.putVec3(
        START_POS_KEY,
        rootObj.getTransform().getLocalPosition(),
      )
    }
    if (options.worldRotation) {
      rootObj.getTransform().setWorldRotation(options.worldRotation)
      initialData.putQuat(
        START_ROT_KEY,
        rootObj.getTransform().getLocalRotation(),
      )
    }
    if (options.worldScale) {
      rootObj.getTransform().setWorldScale(options.worldScale)
      initialData.putVec3(
        START_SCALE_KEY,
        rootObj.getTransform().getLocalScale(),
      )
    }
    if (options.localPosition) {
      rootObj.getTransform().setLocalPosition(options.localPosition)
      initialData.putVec3(
        START_POS_KEY,
        rootObj.getTransform().getLocalPosition(),
      )
    }
    if (options.localRotation) {
      rootObj.getTransform().setLocalRotation(options.localRotation)
      initialData.putQuat(
        START_ROT_KEY,
        rootObj.getTransform().getLocalRotation(),
      )
    }
    if (options.localScale) {
      rootObj.getTransform().setLocalScale(options.localScale)
      initialData.putVec3(
        START_SCALE_KEY,
        rootObj.getTransform().getLocalScale(),
      )
    }

    let shouldIOwn = false

    const persistence = getPersistenceFromValue(options.persistence)

    const storeOptions = RealtimeStoreCreateOptions.create()
    storeOptions.initialStore = initialData
    storeOptions.persistence = persistence
    storeOptions.ownership = RealtimeStoreCreateOptions.Ownership.Unowned
    if (options.claimOwnership || this.spawnerOwnsObject) {
      shouldIOwn = true
      storeOptions.ownership = RealtimeStoreCreateOptions.Ownership.Owned
    }

    this.spawningInstances[networkId] = rootObj

    SessionController.getInstance()
      .getSession()
      .createRealtimeStore(
        storeOptions,
        (store: GeneralDataStore) => {
          this.log.d("created prefab and got store callback")
          let ownerInfo = null
          if (shouldIOwn) {
            ownerInfo = SessionController.getInstance().getLocalUserInfo()
          }
          const networkRoot = new NetworkRootInfo(
            rootObj,
            networkId,
            store,
            true,
            ownerInfo,
            persistence,
          )
          delete this.spawningInstances[networkId]
          this.spawnedInstances[networkId] = networkRoot
          prefab.instantiate(rootObj)
          networkRoot.finishSetup()
          if (options.onSuccess) {
            options.onSuccess(networkRoot)
          }
        },
        (string) => options.onError(string),
      )
  }

  /**
   * Instantiates a prefab from a data store.
   * @param store - The data store containing the prefab information.
   * @param ownerInfo - Information about the owner.
   * @returns The instantiated NetworkRootInfo.
   */
  private instantiatePrefabFromStore(
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
  ): NetworkRootInfo {
    const networkId = getNetworkIdFromStore(store)
    const prefabName = store.getString(PREFAB_ID_KEY)
    this.log.d("instantiate prefab from store: " + prefabName + " " + networkId)

    const rootObj = global.scene.createSceneObject("holder:" + networkId)
    if (this.spawnAsChildren) {
      const parentObj = this.spawnUnderParent || this.getSceneObject()
      rootObj.setParent(parentObj)
    }

    if (store.has(START_POS_KEY)) {
      rootObj.getTransform().setLocalPosition(store.getVec3(START_POS_KEY))
    }
    if (store.has(START_ROT_KEY)) {
      rootObj.getTransform().setLocalRotation(store.getQuat(START_ROT_KEY))
    }
    if (store.has(START_SCALE_KEY)) {
      rootObj.getTransform().setLocalScale(store.getVec3(START_SCALE_KEY))
    }

    const networkRoot = new NetworkRootInfo(
      rootObj,
      networkId,
      store,
      false,
      ownerInfo,
    )
    const prefab = this.findPrefabByName(prefabName)
    if (!isNull(prefab)) {
      this.spawnedInstances[networkId] = networkRoot
      prefab.instantiate(rootObj)
      networkRoot.finishSetup()
      return networkRoot
    } else {
      throw (
        "Could not find prefab with matching name: " +
        prefabName +
        ". Make sure it's added to the Instantiator's prefab list!"
      )
    }
  }

  /**
   * Gets the spawner ID from a data store.
   * @param store - The data store.
   * @returns The spawner ID.
   */
  private getSpawnerIdFromStore(store: GeneralDataStore): string {
    return store.getString(SPAWNER_ID_KEY)
  }

  /**
   * Sets the spawner ID on a data store.
   * @param store - The data store.
   * @param id - The spawner ID.
   */
  private setSpawnerIdOnStore(store: GeneralDataStore, id: string) {
    store.putString(SPAWNER_ID_KEY, id)
  }

  /**
   * Handles the creation of a realtime store.
   * @param _session - The multiplayer session.
   * @param store - The data store.
   * @param ownerInfo - Information about the owner.
   */
  private onRealtimeStoreCreated(
    _session: MultiplayerSession,
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
  ) {
    this.trySpawnFromStore(store, ownerInfo)
  }

  private spawnInitialInstancesOnReady(): void {
    this.syncEntity.notifyOnReady(() => this.spawnInitialInstances())
  }

  private spawnInitialInstances() {
    const sessionController = SessionController.getInstance()

    sessionController.getTrackedStores().forEach((storeInfo) => {
      this.trySpawnFromStore(storeInfo.store, storeInfo.ownerInfo)
    })
  }

  /**
   * Tries to spawn a prefab from a data store.
   * @param store - The data store.
   * @param ownerInfo - Information about the owner.
   */
  trySpawnFromStore(
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
  ) {
    const networkType = getNetworkTypeFromStore(store)
    const spawnerId = this.getSpawnerIdFromStore(store)

    if (networkType === "prefab" && spawnerId === this.syncEntity.networkId) {
      const networkId = getNetworkIdFromStore(store)
      if (
        !(networkId in this.spawnedInstances) &&
        !(networkId in this.spawningInstances)
      ) {
        this.instantiatePrefabFromStore(store, ownerInfo)
      }
    }
  }

  private onReady(): void {
    if (this.autoInstantiate) {
      const settings = new InstantiationOptions({
        persistence: this.persistence,
        claimOwnership:
          this.autoInstantiateOwnership ===
          RealtimeStoreCreateOptions.Ownership.Owned,
      })
      for (let i = 0; i < this.autoInstantiatePrefabs.length; i++) {
        this.instantiate(this.autoInstantiatePrefabs[i], settings)
      }
    }
    this.spawnInitialInstances()
  }

  /**
   * Instantiates a prefab across the network. The prefab must be included in the "Prefabs" list of the Instantiator's inspector.
   * @param prefab - Prefab to instantiate. Make sure it's included in the "Prefabs" list!
   * @param options - Optional settings for the instantiated object.
   * @param onSuccess - Callback that executes when instantiation is complete. Overrides the `onSuccess` callback in `options` if specified.
   */
  instantiate(
    prefab: ObjectPrefab,
    options?: InstantiationOptions | InstantiationOptionsObj,
    onSuccess?: (networkRoot: NetworkRootInfo) => void,
  ) {
    if (!isNullOrUndefined(onSuccess)) {
      const optionsWithSuccess: InstantiationOptionsObj = options || {}
      optionsWithSuccess.onSuccess = optionsWithSuccess.onSuccess ?? onSuccess
    }
    const instantiationOptions = options || {
      onSuccess: onSuccess,
    }
    const networkId = this.generatePrefabId(prefab, options)
    if (
      !isNullOrUndefined(instantiationOptions) &&
      !isNullOrUndefined(instantiationOptions?.overrideNetworkId) &&
      networkId in this.spawnedInstances
    ) {
      this.log.d("using existing prefab already spawned")
      if (instantiationOptions.onSuccess) {
        instantiationOptions.onSuccess(this.spawnedInstances[networkId])
      }
    } else {
      this.instantiateNewPrefab(networkId, prefab, instantiationOptions)
    }
  }

  /**
   * @deprecated Use instantiate() instead
   * @param prefab - The prefab to instantiate.
   * @param onSuccess - Callback that executes when instantiation is complete.
   * @param persistence - The persistence setting for the instantiated object.
   * @param claimOwnership - Whether to claim ownership of the instantiated object.
   * @param worldPosition - The world position of the instantiated object.
   * @param worldRotation - The world rotation of the instantiated object.
   * @param worldScale - The world scale of the instantiated object.
   */
  doInstantiate(
    prefab: ObjectPrefab,
    onSuccess?: (rootInfo: NetworkRootInfo) => void,
    persistence?: RealtimeStoreCreateOptions.Persistence,
    claimOwnership?: boolean,
    worldPosition?: vec3,
    worldRotation?: quat,
    worldScale?: vec3,
  ) {
    const options = {
      onSuccess: onSuccess,
      persistence: persistence,
      claimOwnership: claimOwnership,
      worldPosition: worldPosition,
      worldRotation: worldRotation,
      worldScale: worldScale,
    }
    this.instantiate(prefab, options)
  }

  /**
   * Checks if the instantiator is ready.
   * @returns `true` if the instantiator is ready, otherwise `false`.
   */
  isReady(): boolean {
    return this.syncEntity.isSetupFinished
  }

  /**
   * Registers a callback to be called when the instantiator is ready.
   * @param onReady - The callback to register.
   */
  notifyOnReady(onReady: () => void) {
    this.syncEntity.notifyOnReady(onReady)
  }
}

// These exports exist for javascript compatibility, and should not be used from typescript code.
;(global as any).InstantiationOptions = InstantiationOptions
