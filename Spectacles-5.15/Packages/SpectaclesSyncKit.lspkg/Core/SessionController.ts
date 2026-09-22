import {Singleton} from "SpectaclesInteractionKit.lspkg/Decorators/Singleton"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {StartMode, StartModeController} from "../StartMenu/Scripts/StartModeController"
import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {EventWrapper} from "./EventWrapper"
import {MockConnectedLensModule, MockMultiplayerSession} from "./MockMultiplayerSession"
import {MockMultiplayerSessionConfig} from "./MockMultiplayerSessionConfig"
import {getNetworkIdFromStore, putNetworkIdToStore} from "./NetworkUtils"

enum State {
  NotInitialized,
  Initialized,
  Ready,
  WaitingForInvite
}

export class StoreInfo {
  constructor(
    public readonly store: GeneralDataStore,
    public readonly ownerInfo: ConnectedLensModule.UserInfo,
    public readonly creationInfo?: ConnectedLensModule.RealtimeStoreCreationInfo
  ) {}
}

const SESSION_STORE_ID = "__session"
const SESSION_SCOPED_STORE_ID = "__session_scoped"
const COLOCATED_BUILD_STATUS_KEY = "_colocated_build_status"
const COLOCATED_MAP_ID = "_colocated_map_id"
const FIRST_JOINER_CONNECTION_ID_KEY = "_first_joiner_connection_id"

const TAG = "SessionController"

/**
 * @deprecated("ColocatedBuildStatus is deprecated and will be removed in a future release")
 */
export enum ColocatedBuildStatus {
  None = "none",
  Building = "building",
  Built = "built"
}

@Singleton
export class SessionController {
  public static getInstance: () => SessionController

  private log = new SyncKitLogger(TAG)

  isConfigured = false
  script: BaseScriptComponent = null
  shouldInitialize = false
  connectedLensModuleToUse: ConnectedLensModule = null
  locationCloudStorageModule: LocationCloudStorageModule = null
  isColocated: boolean = null
  locatedAtComponent: LocatedAtComponent = null
  customLandmark: LocationAsset = null
  startMode: StartMode = null
  skipCustomLandmarkInLensStudio: boolean = null

  configure(
    script: BaseScriptComponent,
    connectedLensModule: ConnectedLensModule,
    locationCloudStorageModule: LocationCloudStorageModule,
    isColocated: boolean,
    locatedAtComponent: LocatedAtComponent,
    startMode: StartMode,
    skipCustomLandmarkInLensStudio: boolean
  ) {
    this.script = script
    this.connectedLensModuleToUse = connectedLensModule
    this.locationCloudStorageModule = locationCloudStorageModule
    this.isColocated = isColocated
    this.locatedAtComponent = locatedAtComponent
    this.customLandmark = this.locatedAtComponent.location
    this.startMode = startMode
    this.skipCustomLandmarkInLensStudio = skipCustomLandmarkInLensStudio

    this._requireSessionStore = this.isColocated

    this.isConfigured = true

    const mappingOptions = LocatedAtComponent.createMappingOptions()
    mappingOptions.locationCloudStorageModule = this.locationCloudStorageModule
    mappingOptions.location = LocationAsset.getAROrigin()

    if (locatedAtComponent !== null) {
      locatedAtComponent.onFound.add(() => {
        this._isLocatedAtFound = true
        this.onLocatedAtFound.trigger()
      })

      // If we are in Lens Studio and skip guidance is enabled, simulate the locatedAt found event immediately
      if (this.skipCustomLandmarkInLensStudio && global.deviceInfoSystem.isEditor()) {
        this._isLocatedAtFound = true
        this.onLocatedAtFound.trigger()
      }
    }

    // We create a MappingSession even for Location Based Experiences (LBEs) with custom landmarks because having it active
    // before a Location is set on the LocatedAtComponent helps localization speed. It causes
    // the map to be accumulated for localization, which helps once the custom location map is
    // downloaded and tracked. This won't consume additional resources as long as no one requests
    // checkpoints. For LBEs where the location might not be set immediately, this is beneficial
    // for re-localization speed.
    this._mappingSession = LocatedAtComponent.createMappingSession(mappingOptions)

    this._checkInitialization()
  }

  worldCamera = WorldCameraFinderProvider.getInstance()

  deviceTrackingComponent = this.worldCamera.getComponent().getSceneObject().getComponent("Component.DeviceTracking")

  eventFlowState = {
    inviteSent: false,
    connected: false,
    shared: false,
    // Session Store
    isWaitingForSessionStore: false,
    // Session Scoped Store
    isWaitingForSessionScopedStore: false,
    // Colocated
    isColocatedSetupStarted: false,
    isColocatedSetupFinished: false
  }

  private _state: State = State.NotInitialized
  private _session: MultiplayerSession = null
  private _mappingSession: MappingSession = null

  private _users: ConnectedLensModule.UserInfo[] = []
  private _userIdLookup: Map<string, ConnectedLensModule.UserInfo[]> = new Map()
  private _connectionIdLookup: Map<string, ConnectedLensModule.UserInfo> = new Map()

  private _sessionCreationType: ConnectedLensSessionOptions.SessionCreationType = null

  private _localUserId: string = null
  private _localConnectionId: string = null
  private _localDisplayName: string = null
  private _localUserInfo: ConnectedLensModule.UserInfo = null

  private _hostUserId: string = null
  private _hostConnectionId: string = null
  private _hostDisplayName: string = null
  private _hostUserInfo: ConnectedLensModule.UserInfo = null

  private _storeInfos: StoreInfo[] = []
  private _storeLookup: Map<string, StoreInfo> = new Map()

  private _requireSessionStore: boolean = null

  private _sessionStore: GeneralDataStore

  private _sessionScopedStore: GeneralDataStore

  private _isReady = false

  private _hasSentReady = false

  private _hasSentMapExists = false

  private _hasSentColocatedMapId = false

  private _isLocatedAtFound = false

  private _isSingleplayer = false

  onReady: EventWrapper<[]> = new EventWrapper()

  onStartColocated: EventWrapper<[]> = new EventWrapper()

  onMapExists: EventWrapper<[]> = new EventWrapper()

  onLocationId: EventWrapper<[]> = new EventWrapper()

  onSessionCreated: EventWrapper<[MultiplayerSession, ConnectedLensSessionOptions.SessionCreationType]> =
    new EventWrapper()

  onSessionShared: EventWrapper<[MultiplayerSession]> = new EventWrapper()

  onConnected: EventWrapper<[session: MultiplayerSession, connectionInfo: ConnectedLensModule.ConnectionInfo]> =
    new EventWrapper()

  onDisconnected: EventWrapper<[session: MultiplayerSession, disconnectInfo: string]> = new EventWrapper()

  onMessageReceived: EventWrapper<
    [session: MultiplayerSession, userId: string, message: string, senderInfo: ConnectedLensModule.UserInfo]
  > = new EventWrapper()

  onUserJoinedSession: EventWrapper<[session: MultiplayerSession, userInfo: ConnectedLensModule.UserInfo]> =
    new EventWrapper()

  onUserLeftSession: EventWrapper<[session: MultiplayerSession, userInfo: ConnectedLensModule.UserInfo]> =
    new EventWrapper()

  onHostUpdated: EventWrapper<[session: MultiplayerSession, removalInfo: ConnectedLensModule.HostUpdateInfo]> =
    new EventWrapper()

  onError: EventWrapper<[session: MultiplayerSession, code: string, description: string]> = new EventWrapper()

  onConnectionFailed: EventWrapper<[string, string]> = new EventWrapper()

  onRealtimeStoreCreated: EventWrapper<
    [
      session: MultiplayerSession,
      store: GeneralDataStore,
      ownerInfo: ConnectedLensModule.UserInfo,
      creationInfo: ConnectedLensModule.RealtimeStoreCreationInfo
    ]
  > = new EventWrapper()

  onRealtimeStoreUpdated: EventWrapper<
    [
      session: MultiplayerSession,
      store: GeneralDataStore,
      key: string,
      updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo
    ]
  > = new EventWrapper()

  onRealtimeStoreDeleted: EventWrapper<
    [session: MultiplayerSession, store: GeneralDataStore, deleteInfo: ConnectedLensModule.RealtimeStoreDeleteInfo]
  > = new EventWrapper()

  onRealtimeStoreKeyRemoved: EventWrapper<
    [session: MultiplayerSession, store: GeneralDataStore, removalInfo: ConnectedLensModule.RealtimeStoreKeyRemovalInfo]
  > = new EventWrapper()

  onRealtimeStoreOwnershipUpdated: EventWrapper<
    [
      session: MultiplayerSession,
      store: GeneralDataStore,
      ownerInfo: ConnectedLensModule.UserInfo,
      ownershipUpdateInfo: ConnectedLensModule.RealtimeStoreOwnershipUpdateInfo
    ]
  > = new EventWrapper()

  onLocatedAtFound: EventWrapper<[]> = new EventWrapper()

  callbacks = {
    onReady: this.onReady,
    onStartColocated: this.onStartColocated,
    onMapExists: this.onMapExists,
    onLocationId: this.onLocationId,
    onSessionCreated: this.onSessionCreated,
    onSessionShared: this.onSessionShared,
    onConnected: this.onConnected,
    onDisconnected: this.onDisconnected,
    onMessageReceived: this.onMessageReceived,
    onUserJoinedSession: this.onUserJoinedSession,
    onUserLeftSession: this.onUserLeftSession,
    onHostUpdated: this.onHostUpdated,
    onError: this.onError,
    onConnectionFailed: this.onConnectionFailed,
    onRealtimeStoreCreated: this.onRealtimeStoreCreated,
    onRealtimeStoreUpdated: this.onRealtimeStoreUpdated,
    onRealtimeStoreDeleted: this.onRealtimeStoreDeleted,
    onRealtimeStoreKeyRemoved: this.onRealtimeStoreKeyRemoved,
    onRealtimeStoreOwnershipUpdated: this.onRealtimeStoreOwnershipUpdated,
    onLocatedAtFound: this.onLocatedAtFound
  }

  createSessionOptions() {
    const options = ConnectedLensSessionOptions.create()
    options.onSessionCreated = (session, creationType) => this._onSessionCreated(session, creationType)
    options.onConnected = (session, connectionInfo) => this._onConnected(session, connectionInfo)
    options.onDisconnected = (session, disconnectInfo) => this._onDisconnected(session, disconnectInfo)
    options.onMessageReceived = (session, userId, message, senderInfo) =>
      this._onMessageReceived(session, userId, message, senderInfo)
    options.onUserJoinedSession = (session, userInfo) => this._onUserJoinedSession(session, userInfo)
    options.onUserLeftSession = (session, userInfo) => this._onUserLeftSession(session, userInfo)
    options.onHostUpdated = (session, removalInfo) => this._onHostUpdated(session, removalInfo)
    options.onError = (session, code, description) => this._onError(session, code, description)
    options.onRealtimeStoreCreated = (session, store, ownerInfo, creationInfo) =>
      this._onRealtimeStoreCreated(session, store, ownerInfo, creationInfo)
    options.onRealtimeStoreUpdated = (session, store, key, updateInfo) =>
      this._onRealtimeStoreUpdated(session, store, key, updateInfo)
    options.onRealtimeStoreDeleted = (session, store, deleteInfo) =>
      this._onRealtimeStoreDeleted(session, store, deleteInfo)
    options.onRealtimeStoreOwnershipUpdated = (session, store, owner, ownershipUpdateInfo) =>
      this._onRealtimeStoreOwnershipUpdated(session, store, owner, ownershipUpdateInfo)
    options.onRealtimeStoreKeyRemoved = (session, removalInfo) => this._onRealtimeStoreKeyRemoved(session, removalInfo)
    options.hostManagementEnabled = true
    return options
  }

  private createSession() {
    this.log.i("Creating session")
    const options = this.createSessionOptions()
    this.connectedLensModuleToUse.createSession(options)
  }

  /**
   * Handles the session creation event.
   * @param session - The multiplayer session.
   * @param creationType - The session creation type.
   */
  private _onSessionCreated(
    session: MultiplayerSession,
    creationType: ConnectedLensSessionOptions.SessionCreationType
  ) {
    this.log.i(`Session Created: ${creationType}`)
    this._session = session
    this._sessionCreationType = creationType
    // We can't pass the mock object to an actual Lens Studio type.
    if (!(session instanceof MockMultiplayerSession)) {
      this.locationCloudStorageModule.session = session
    }
    this.onSessionCreated.trigger(session, creationType)
  }

  /**
   * Handles the session shared event.
   * @param session - The multiplayer session.
   */
  private _onSessionShared(session: MultiplayerSession) {
    this.log.i("Session Shared")
    this._session = session
    this.eventFlowState.shared = true
    this.onSessionShared.trigger(session)
    this._checkIfReady()
  }

  /**
   * Handles the connected event.
   * @param session - The multiplayer session.
   * @param connectionInfo - The connection information.
   */
  private _onConnected(session: MultiplayerSession, connectionInfo: ConnectedLensModule.ConnectionInfo) {
    this.log.i("Connected to session")
    this._session = session

    this._users = []
    this._userIdLookup = new Map()
    this._connectionIdLookup = new Map()

    this._localUserInfo = connectionInfo.localUserInfo
    this._localDisplayName = this._localUserInfo.displayName
    this._localUserId = this._localUserInfo.userId
    this._localConnectionId = this._localUserInfo.connectionId

    this._hostUserInfo = connectionInfo.hostUserInfo
    this._hostDisplayName = this._hostUserInfo.displayName
    this._hostUserId = this._hostUserInfo.userId
    this._hostConnectionId = this._hostUserInfo.connectionId

    // Track local user
    this._trackUser(connectionInfo.localUserInfo)

    // Track other users
    const otherUsers = connectionInfo.externalUsersInfo
    for (let i = 0; i < otherUsers.length; i++) {
      this._trackUser(otherUsers[i])
    }

    // Track existing stores
    const stores = connectionInfo.realtimeStores
    const creationInfos = connectionInfo.realtimeStoresCreationInfos
    for (let j = 0; j < creationInfos.length; j++) {
      this._trackStore(stores[j], creationInfos[j].ownerInfo, creationInfos[j])
    }

    this.eventFlowState.connected = true
    this.onConnected.trigger(this._session, connectionInfo)
    this._checkIfReady()
  }

  /**
   * Handles the disconnected event.
   * @param session - The multiplayer session.
   * @param disconnectInfo - The disconnect information.
   */
  private _onDisconnected(session: MultiplayerSession, disconnectInfo: string) {
    this.log.d("disconnected from session: " + disconnectInfo)
    this.onDisconnected.trigger(session, disconnectInfo)
  }

  /**
   * Handles the message received event.
   * @param session - The multiplayer session.
   * @param userId - The user ID.
   * @param message - The message content.
   * @param senderInfo - Information about the sender.
   */
  private _onMessageReceived(
    session: MultiplayerSession,
    userId: string,
    message: string,
    senderInfo: ConnectedLensModule.UserInfo
  ) {
    this.onMessageReceived.trigger(session, userId, message, senderInfo)
  }

  /**
   * Handles the error event.
   * @param session - The multiplayer session.
   * @param code - The error code.
   * @param description - The error description.
   */
  private _onError(session: MultiplayerSession, code: string, description: string) {
    this._state = State.NotInitialized

    this.log.e("Error: " + code + " - " + description)
    this.onError.trigger(session, code, description)

    if (this._session === null) {
      this.onConnectionFailed.trigger(code, description)
    }
  }

  /**
   * Tracks a store.
   * @param store - The data store.
   * @param ownerInfo - Information about the owner.
   * @param creationInfo - Information about the store creation.
   */
  private _trackStore(
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
    creationInfo?: ConnectedLensModule.RealtimeStoreCreationInfo
  ) {
    const storeId = getNetworkIdFromStore(store)
    this.log.d(`Tracking store: ${storeId}`)

    if (storeId !== null && storeId !== undefined && storeId !== "") {
      if (!(storeId in this._storeLookup)) {
        const storeInfo = new StoreInfo(store, ownerInfo, creationInfo)
        this._storeLookup[storeId] = storeInfo
        this._storeInfos.push(storeInfo)
      }
    }
  }

  /**
   * Untracks a store.
   * @param store - The data store.
   */
  private _untrackStore(store: GeneralDataStore) {
    const storeId = getNetworkIdFromStore(store)
    this.log.d(`Untracking store: ${storeId}`)

    if (storeId !== null && storeId !== undefined && storeId !== "") {
      delete this._storeLookup[storeId]
      this._storeInfos = this._storeInfos.filter((storeInfo: StoreInfo) => {
        return storeId != getNetworkIdFromStore(storeInfo.store)
      })
    }
  }

  /**
   * Gets the tracked stores.
   * @returns The tracked stores.
   */
  getTrackedStores(): StoreInfo[] {
    return this._storeInfos
  }

  /**
   * Handles the realtime store created event.
   * @param session - The multiplayer session.
   * @param store - The data store.
   * @param ownerInfo - Information about the owner.
   * @param creationInfo - Information about the store creation.
   */
  private _onRealtimeStoreCreated(
    session: MultiplayerSession,
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
    creationInfo: ConnectedLensModule.RealtimeStoreCreationInfo
  ) {
    this.log.d("_onRealtimeStoreCreated " + ownerInfo.displayName)
    this._trackStore(store, ownerInfo, creationInfo)
    this.onRealtimeStoreCreated.trigger(session, store, ownerInfo, creationInfo)
  }

  /**
   * Handles the realtime store updated event.
   * @param session - The multiplayer session.
   * @param store - The data store.
   * @param key - The key that was updated.
   * @param updateInfo - Information about the update.
   */
  private _onRealtimeStoreUpdated(
    session: MultiplayerSession,
    store: GeneralDataStore,
    key: string,
    updateInfo?: ConnectedLensModule.RealtimeStoreUpdateInfo
  ) {
    this.onRealtimeStoreUpdated.trigger(session, store, key, updateInfo)
  }

  /**
   * Handles the realtime store deleted event.
   * @param session - The multiplayer session.
   * @param store - The data store.
   * @param deleteInfo - Information about the deletion.
   */
  private _onRealtimeStoreDeleted(
    session: MultiplayerSession,
    store: GeneralDataStore,
    deleteInfo: ConnectedLensModule.RealtimeStoreDeleteInfo
  ) {
    this._untrackStore(store)
    this.onRealtimeStoreDeleted.trigger(session, store, deleteInfo)
  }

  /**
   * Handles the realtime store key removed event.
   * @param session - The multiplayer session.
   * @param removalInfo - Information about the key removal.
   */
  private _onRealtimeStoreKeyRemoved(
    session: MultiplayerSession,
    removalInfo: ConnectedLensModule.RealtimeStoreKeyRemovalInfo
  ) {
    const store = removalInfo.store
    this.onRealtimeStoreKeyRemoved.trigger(session, store, removalInfo)
  }

  /**
   * Handles the realtime store ownership updated event.
   * @param session - The multiplayer session.
   * @param store - The data store.
   * @param owner - Information about the new owner.
   * @param ownershipUpdateInfo - Information about the ownership update.
   */
  private _onRealtimeStoreOwnershipUpdated(
    session: MultiplayerSession,
    store: GeneralDataStore,
    owner: ConnectedLensModule.UserInfo,
    ownershipUpdateInfo: ConnectedLensModule.RealtimeStoreOwnershipUpdateInfo
  ) {
    this._trackStore(store, owner)
    this.onRealtimeStoreOwnershipUpdated.trigger(session, store, owner, ownershipUpdateInfo)
  }

  /**
   * Helper function to add a UserInfo to a list of UserInfo, only if the list doesn't contain a user with
   * matching connectionId. Returns true if the user was added to the list.
   * @param userList - The list of UserInfo.
   * @param newUser - The new user to add.
   * @returns True if the user was added to the list.
   */
  private _addMissingUserToListByConnectionId(
    userList: ConnectedLensModule.UserInfo[],
    newUser: ConnectedLensModule.UserInfo
  ): boolean {
    if (
      newUser === null ||
      newUser === undefined ||
      newUser.connectionId === null ||
      newUser.connectionId === undefined
    ) {
      return false
    }

    const newConnectionId = newUser.connectionId
    for (let i = 0; i < userList.length; i++) {
      if (userList[i].connectionId === newConnectionId) {
        return false
      }
    }

    userList.push(newUser)
    return true
  }

  /**
   * Tracks a user.
   * @param userInfo - Information about the user.
   * @returns True if the user was newly added.
   */
  private _trackUser(userInfo: ConnectedLensModule.UserInfo): boolean {
    let newUserJoined = false
    if (!(userInfo.connectionId in this._connectionIdLookup)) {
      this._connectionIdLookup[userInfo.connectionId] = userInfo
      newUserJoined = true
    }

    let userList = this._userIdLookup[userInfo.userId]
    if (!userList) {
      userList = [userInfo]
      this._userIdLookup[userInfo.userId] = userList
      newUserJoined = true
    } else {
      newUserJoined = this._addMissingUserToListByConnectionId(userList, userInfo) || newUserJoined
    }

    newUserJoined = this._addMissingUserToListByConnectionId(this._users, userInfo) || newUserJoined

    return newUserJoined
  }

  /**
   * Helper function to remove all instances of UserInfo with matching connectionId from a list.
   * Returns the list with users removed.
   * @param userList - The list of UserInfo.
   * @param userInfo - Information about the user to remove.
   * @returns The list with users removed.
   */
  private _removeUserFromListByConnectionId(
    userList: ConnectedLensModule.UserInfo[],
    userInfo: ConnectedLensModule.UserInfo
  ): ConnectedLensModule.UserInfo[] {
    if (
      userInfo === null ||
      userInfo === undefined ||
      userInfo.connectionId === null ||
      userInfo.connectionId === undefined
    ) {
      return userList
    }
    const connectionId = userInfo.connectionId
    return userList.filter((u) => {
      return u.connectionId !== connectionId
    })
  }

  /**
   * Untracks a user.
   * @param userInfo - Information about the user.
   */
  private _untrackUser(userInfo: ConnectedLensModule.UserInfo) {
    const connectionId = userInfo.connectionId

    delete this._connectionIdLookup[connectionId]

    const userList = this._userIdLookup[userInfo.userId]
    if (userList) {
      this._userIdLookup[userInfo.userId] = this._removeUserFromListByConnectionId(userList, userInfo)
    }

    this._users = this._removeUserFromListByConnectionId(this._users, userInfo)
  }

  /**
   * Handles the user joined session event.
   * @param session - The multiplayer session.
   * @param userInfo - Information about the user.
   */
  private _onUserJoinedSession(session: MultiplayerSession, userInfo: ConnectedLensModule.UserInfo) {
    if (this._trackUser(userInfo)) {
      this.log.d("user joined session: " + userInfo.displayName)
      this.onUserJoinedSession.trigger(session, userInfo)
    } else {
      this.log.d("skipping duplicate user: " + userInfo.displayName)
    }
  }

  /**
   * Handles the user left session event.
   * @param session - The multiplayer session.
   * @param userInfo - Information about the user.
   */
  private _onUserLeftSession(session: MultiplayerSession, userInfo: ConnectedLensModule.UserInfo) {
    this._untrackUser(userInfo)
    this.onUserLeftSession.trigger(session, userInfo)
  }

  /**
   * Handles the host updated event.
   * @param session - The multiplayer session.
   * @param removalInfo - Information about the host update.
   */
  private _onHostUpdated(session: MultiplayerSession, removalInfo: ConnectedLensModule.HostUpdateInfo) {
    this._hostUserInfo = removalInfo.userInfo
    this._hostDisplayName = this._hostUserInfo.displayName
    this._hostUserId = this._hostUserInfo.userId
    this._hostConnectionId = this._hostUserInfo.connectionId
    this.onHostUpdated.trigger(session, removalInfo)
  }

  // Session Store

  /**
   * Returns the shared session store (if exists) or null. Useful for needed session info like colocated build status.
   * @returns The shared session store or null.
   */
  getSessionStore(): GeneralDataStore | null {
    if (!this._sessionStore) {
      const sessionInfo = this.getStoreInfoById(SESSION_STORE_ID)
      if (sessionInfo) {
        this._sessionStore = sessionInfo.store
      }
    }
    return this._sessionStore
  }

  /**
   * Returns the shared session-scoped store (if exists) or null. Useful for session-scoped data like first joiner info.
   * @returns The shared session-scoped store or null.
   */
  private getSessionScopedStore(): GeneralDataStore | null {
    if (!this._sessionScopedStore) {
      const sessionScopedInfo = this.getStoreInfoById(SESSION_SCOPED_STORE_ID)
      if (sessionScopedInfo) {
        this._sessionScopedStore = sessionScopedInfo.store
      }
    }
    return this._sessionScopedStore
  }

  private _createSessionStore() {
    const storeOpts = RealtimeStoreCreateOptions.create()
    storeOpts.persistence = RealtimeStoreCreateOptions.Persistence.Persist

    const startingStore = GeneralDataStore.create()
    // Set network ID
    putNetworkIdToStore(startingStore, SESSION_STORE_ID)
    // Set colocated build status
    startingStore.putString(COLOCATED_BUILD_STATUS_KEY, ColocatedBuildStatus.None)
    storeOpts.initialStore = startingStore

    this.log.d("creating the session store")

    this.createStore(
      storeOpts,
      (store: GeneralDataStore) => {
        this.log.d("created session store")
        this._sessionStore = store
        this._checkIfReady()
      },
      (message: string) => {
        this.log.e("error creating shared store: " + message)
      }
    )
  }

  private _createSessionScopedStore() {
    const storeOpts = RealtimeStoreCreateOptions.create()
    storeOpts.persistence = RealtimeStoreCreateOptions.Persistence.Session

    const startingStore = GeneralDataStore.create()
    // Set network ID
    putNetworkIdToStore(startingStore, SESSION_SCOPED_STORE_ID)
    // Set first joiner connection ID to current connection if we're creating the store
    startingStore.putString(FIRST_JOINER_CONNECTION_ID_KEY, this.getLocalConnectionId())
    storeOpts.initialStore = startingStore

    this.log.d("creating the session-scoped store")

    this.createStore(
      storeOpts,
      (store: GeneralDataStore) => {
        this.log.d("created session-scoped store")
        this._sessionScopedStore = store
        this._checkIfReady()
      },
      (message: string) => {
        this.log.e("error creating session-scoped store: " + message)
      }
    )
  }

  private _waitAndCreateSessionStore() {
    this._waitUntilTrue(
      () => {
        return this.getSessionStore() !== null && this.getSessionStore() !== undefined
      },
      () => {
        this.log.d("found session store")
        this._checkIfReady()
      },
      // Timeout
      0.1,
      () => this._createSessionStore()
    )
  }

  private _waitAndCreateSessionScopedStore() {
    this._waitUntilTrue(
      () => {
        return this.getSessionScopedStore() !== null && this.getSessionScopedStore() !== undefined
      },
      () => {
        this.log.d("found session-scoped store")
        this._checkIfReady()
      },
      // Timeout
      0.1,
      () => this._createSessionScopedStore()
    )
  }

  // Colocated Flow

  /**
   * Start setting up Colocated flow.
   */
  private _startColocated() {
    this.log.d("startColocated()")

    if (!this.locationCloudStorageModule) {
      throw "Location Cloud Storage Module must be set!"
    }

    if (!this.eventFlowState.isColocatedSetupStarted) {
      this.onStartColocated.trigger()
      this.setIsConnectionFirstJoiner(this.isHost() && this.locatedAtComponent.location === null)

      // Retrieve shared session map with getNearbyLocationStores if custom landmark is not set
      if (!this.customLandmark) {
        if (global.deviceInfoSystem.isEditor()) {
          // Discovery doesn't work properly in editor, so we use the AR origin for testing
          this.locatedAtComponent.location = LocationAsset.getAROrigin()
        } else {
          const options = LocationCloudStorageOptions.create()

          const discoveredNearby = options.onDiscoveredNearby.add(
            (locationAsset: LocationAsset, _locationCloudStore: LocationCloudStore) => {
              if (locationAsset && this.locatedAtComponent.location === null) {
                this.locatedAtComponent.location = locationAsset
                options.onDiscoveredNearby.remove(discoveredNearby)

                if (this.isHost()) {
                  this.setColocatedBuildStatus(ColocatedBuildStatus.Built)
                }

                if (!this._hasSentMapExists) {
                  this._hasSentMapExists = true
                  this.onMapExists.trigger()
                }
              }
            }
          )
          options.onError.add((_locationAsset: LocationAsset, errorCode: string, errorMessage: string) => {
            this.log.e(`Error during nearby location discovery: ${errorCode} - ${errorMessage}`)
          })

          this.locationCloudStorageModule.getNearbyLocationStores(options)
        }
      }

      // Start discovery - colocation completes on locatedAtComponent onFound event for all locations.
      this.notifyOnLocatedAtFound(() => {
        this.log.i("Located At Found. Colocated setup finished.")
        this.eventFlowState.isColocatedSetupFinished = true
        this._checkIfReady()
      })
    }

    this.eventFlowState.isColocatedSetupStarted = true
  }

  /**
   * @deprecated - this is no longer needed as getNearbyLocationStores handles colocated build logic.
   * onMapExists is now triggered by getNearbyLocationStores - use {@link getMapExists} instead to check if a map has been retrieved.
   * @returns The colocated build status if set manually, null otherwise.
   */
  getColocatedBuildStatus(): ColocatedBuildStatus {
    this.log.w("getColocatedBuildStatus is deprecated and will be removed in a future release")
    const sessionStore = this.getSessionStore()
    return sessionStore ? (sessionStore.getString(COLOCATED_BUILD_STATUS_KEY) as ColocatedBuildStatus) : null
  }

  /**
   * @deprecated - this is no longer needed as getNearbyLocationStores handles colocated build logic.
   */
  setColocatedBuildStatus(status: ColocatedBuildStatus) {
    this.log.w("setColocatedBuildStatus is deprecated and will be removed in a future release")
    try {
      this.getSessionStore().putString(COLOCATED_BUILD_STATUS_KEY, status)
    } catch (error) {
      this.log.e("error setting colocated build status: " + error)
    }
  }

  /**
   * @deprecated - this is no longer needed & will not be set by default as getNearbyLocationStores handles map retrieval.
   * Get the id of the colocated map.
   * @returns The colocated map id.
   */
  getColocatedMapId(): string {
    this.log.w("getColocatedMapId is deprecated and will be removed in a future release")
    const sessionStore = this.getSessionStore()
    return sessionStore ? sessionStore.getString(COLOCATED_MAP_ID) : null
  }

  /**
   * @deprecated - this is no longer needed as getNearbyLocationStores handles map retrieval.
   * Write the id of the colocated map.
   * @param value - The map id.
   */
  setColocatedMapId(value: string) {
    this.log.w("setColocatedMapId is deprecated and will be removed in a future release")
    try {
      this.getSessionStore().putString(COLOCATED_MAP_ID, value)
    } catch (error) {
      this.log.e("error setting colocated map id: " + error)
    }
  }

  // General flow

  /**
   * Checks the current status of all required systems and runs through the steps needed to finish setup.
   */
  private _checkIfReady() {
    // We need a session to continue
    if (!this._session) {
      return
    }

    // We need local user info to continue
    if (!this._localUserId) {
      return
    }

    // We need to be connected to the session to continue
    if (!this.eventFlowState.connected) {
      return
    }

    // If we require SessionStore, wait for SessionStore to be setup before continuing
    if (this._requireSessionStore && !this.getSessionStore()) {
      // Start setting up SessionStore if we haven't already
      if (!this.eventFlowState.isWaitingForSessionStore) {
        this.eventFlowState.isWaitingForSessionStore = true
        this._waitAndCreateSessionStore()
      }
      return
    }

    // Wait for session-scoped store to be setup before continuing
    if (!this.getSessionScopedStore()) {
      // Start setting up session-scoped store if we haven't already
      if (!this.eventFlowState.isWaitingForSessionScopedStore) {
        this.eventFlowState.isWaitingForSessionScopedStore = true
        this._waitAndCreateSessionScopedStore()
      }
      return
    }

    // If we are in colocated flow, we need colocated setup to be finished before continuing
    if (this.isColocated && !this._isSingleplayer) {
      if (!this.eventFlowState.isColocatedSetupFinished) {
        if (!this.eventFlowState.isColocatedSetupStarted) {
          this._startColocated()
          this._checkIfReady()
          return
        }
        return
      }
    }

    this.log.d("session is now ready, triggering ready events")

    this._state = State.Ready

    // Mark as ready and send all onReady events if we haven't already
    if (!this._hasSentReady) {
      this._isReady = true
      this._hasSentReady = true
      if (!isNull((global as any).behaviorSystem)) {
        ;(global as any).behaviorSystem.sendCustomTrigger("session_ready")
      }
      // Introduce a delay before triggering onReady to allow the world camera to reset its position
      const delayEvent = this.script.createEvent("DelayedCallbackEvent")
      delayEvent.bind(() => {
        this.onReady.trigger()
      })
      delayEvent.reset(0.23)
    }
  }

  // Start setup
  init() {
    this.shouldInitialize = true
    this._checkInitialization()
  }

  private _checkInitialization() {
    if (this.isConfigured && this.shouldInitialize && this._state === State.NotInitialized) {
      this.doInit()
    }
  }

  private doInit() {
    this._state = State.Initialized
    this.createSession()
  }

  /**
   * Returns the current {@link MultiplayerSession}. Returns null if the session doesn't exist yet.
   * @returns The current multiplayer session or null.
   */
  getSession(): MultiplayerSession | null {
    return this._session
  }

  /**
   * Returns the LocationCloudStorageModule.
   * @returns The LocationCloudStorageModule.
   */
  getLocationCloudStorageModule(): LocationCloudStorageModule {
    return this.locationCloudStorageModule
  }

  /**
   * Returns the current {@link MappingSession}. Returns null if the session doesn't exist yet.
   * @returns The current mapping session or null.
   */
  getMappingSession(): MappingSession | null {
    return this._mappingSession
  }

  /**
   * Returns the located at component.
   * @returns The located at component.
   */
  getLocatedAtComponent(): LocatedAtComponent {
    return this.locatedAtComponent
  }

  /**
   * Returns the colocated tracking component.
   * @returns The colocated tracking component.
   */
  getDeviceTrackingComponent(): DeviceTracking {
    return this.deviceTrackingComponent
  }

  /**
   * Returns the current state.
   * @returns The current state.
   */
  getState(): State {
    return this._state
  }

  /**
   * Returns the session creation type.
   * @returns The session creation type.
   */
  getSessionCreationType(): ConnectedLensSessionOptions.SessionCreationType {
    return this._sessionCreationType
  }

  /**
   * Returns the local user id, or null.
   * @returns The local user id or null.
   */
  getLocalUserId(): string | null {
    return this._localUserId
  }

  /**
   * Returns the local connection id, or null.
   * @returns The local connection id or null.
   */
  getLocalConnectionId(): string | null {
    return this._localConnectionId
  }

  /**
   * Returns the local display name, or null.
   * @returns The local display name or null.
   */
  getLocalUserName(): string | null {
    return this._localDisplayName
  }

  /**
   * Returns the local user info, or null.
   * @returns The local user info or null.
   */
  getLocalUserInfo(): ConnectedLensModule.UserInfo {
    return this._localUserInfo
  }

  /**
   * Returns true if the passed in `userInfo` matches the local userId. Note that this is separate from connectionId.
   * @param userInfo - The user info to check.
   * @returns True if the user info matches the local userId.
   */
  isSameUserAsLocal(userInfo: ConnectedLensModule.UserInfo): boolean {
    return this._localUserInfo && this._localUserId === userInfo.userId
  }

  /**
   * Returns true if the passed in `userInfo` matches the local user and connection.
   * @param userInfo - The user info to check.
   * @returns True if the user info matches the local user and connection.
   */
  isLocalUserConnection(userInfo: ConnectedLensModule.UserInfo): boolean {
    return this._localUserInfo && userInfo && this._localConnectionId === userInfo.connectionId
  }

  /**
   * Returns the host user id, or null.
   * @returns The host user id or null.
   */
  getHostUserId(): string | null {
    return this._hostUserId
  }

  /**
   * Returns the host connection id, or null.
   * @returns The host connection id or null.
   */
  getHostConnectionId(): string | null {
    return this._hostConnectionId
  }

  /**
   * Returns the host display name, or null.
   * @returns The host display name or null.
   */
  getHostUserName(): string | null {
    return this._hostDisplayName
  }

  /**
   * Returns the host user info, or null.
   * @returns The host user info or null.
   */
  getHostUserInfo(): ConnectedLensModule.UserInfo {
    return this._hostUserInfo
  }

  /**
   * Returns true if the passed in `userInfo` matches the host userId. Note that this is separate from connectionId.
   * @param userInfo - The user info to check.
   * @returns True if the user info matches the host userId.
   */
  isSameUserAsHost(userInfo: ConnectedLensModule.UserInfo): boolean {
    return this._hostUserInfo && this._hostUserId === userInfo.userId
  }

  /**
   * Returns true if the passed in `userInfo` matches the host user and connection.
   * @param userInfo - The user info to check.
   * @returns True if the user info matches the host user and connection.
   */
  isHostUserConnection(userInfo: ConnectedLensModule.UserInfo): boolean {
    return this._hostUserInfo && userInfo && this._hostConnectionId === userInfo.connectionId
  }

  /**
   * Returns true if the local user is the host, or null if the session doesn't exist yet.
   * @returns True if the local user is the host, or null if the session doesn't exist yet.
   */
  isHost(): boolean | null {
    if (!this.eventFlowState.connected) {
      return null
    } else {
      return this.isHostUserConnection(this._localUserInfo)
    }
  }

  /**
   * Returns true if the session is singleplayer.
   * @returns Whether the session is singleplayer.
   */
  isSingleplayer(): boolean {
    return this._isSingleplayer
  }

  /**
   * Returns the list of current user connections.
   * @returns The list of current user connections.
   */
  getUsers(): ConnectedLensModule.UserInfo[] {
    return this._users
  }

  /**
   * Returns the user info with matching id, or null.
   * @deprecated Use {@link getUserByConnectionId | getUserByConnectionId} or {@link getUsersByUserId | getUsersByUserId}
   * @param userId - The user id.
   * @returns The user info with matching id, or null.
   */
  getUserById(userId: string): ConnectedLensModule.UserInfo | null {
    this.log.w("getUserById is deprecated; use getUserByConnectionId() or getUsersByUserId() instead")
    const users = this.getUsersByUserId(userId)
    if (users.length > 0) {
      return users[0]
    }
    return null
  }

  /**
   * Returns the user info with matching connection id, or null.
   * @param connectionId - The connection id.
   * @returns The user info with matching connection id, or null.
   */
  getUserByConnectionId(connectionId: string): ConnectedLensModule.UserInfo | null {
    return this._connectionIdLookup[connectionId] || null
  }

  /**
   * Returns the list of users with matching user id.
   * @param userId - The user id.
   * @returns The list of users with matching user id.
   */
  getUsersByUserId(userId: string): ConnectedLensModule.UserInfo[] {
    return this._userIdLookup[userId] || []
  }

  /**
   * Returns true if the session has been shared.
   * @returns True if the session has been shared.
   */
  getIsSessionShared(): boolean {
    return this.eventFlowState.shared
  }

  /**
   * Returns StoreInfo for the store with matching id.
   * @param networkId - The network id.
   * @returns StoreInfo for the store with matching id.
   */
  getStoreInfoById(networkId: string): StoreInfo | null {
    return this._storeLookup[networkId] ?? null
  }

  /**
   * Create a RealtimeStore.
   * @param storeOptions - The store options.
   * @param onSuccess - Callback for success.
   * @param onError - Callback for error.
   */
  createStore(
    storeOptions: RealtimeStoreCreateOptions,
    onSuccess?: (store: GeneralDataStore) => void,
    onError?: (message: string) => void
  ) {
    this._session.createRealtimeStore(
      storeOptions,
      onSuccess || (() => {}),
      onError ||
        ((message) => {
          this.log.e(message)
          throw Error(message)
        })
    )
  }

  /**
   * Returns a unix timestamp in seconds of the current time according to the server.
   * Useful for synchronizing time-based game events across devices.
   * -1 will be returned if session is not connected to the server.
   * @returns The unix timestamp in seconds of the current time according to the server.
   */
  getServerTimeInSeconds(): number | null {
    if (this._session) {
      return this._session.getServerTimestamp() * 0.001
    }
    return null
  }

  /**
   * Share an Invite to the session.
   */
  shareInvite() {
    if (!this._session) {
      throw Error("Unable to share invite: session is not created!")
    }
    if (!this.connectedLensModuleToUse) {
      throw Error("Unable to share invite: connected lens module not set!")
    }
    if (this._state != State.Ready && this._state != State.WaitingForInvite) {
      throw Error("Unable to share invite: session controller is not ready!")
    }

    this.eventFlowState.connected = false
    this.eventFlowState.shared = false

    this.connectedLensModuleToUse.shareSession(ConnectedLensModule.SessionShareType.Invitation, this._onSessionShared)
  }

  /**
   * Returns true if we're ready to start the colocated tracking flow.
   * @returns True if we're ready to start the colocated tracking flow.
   */
  getOnStartColocated(): boolean {
    return this.eventFlowState.isColocatedSetupStarted
  }

  /**
   * Executes the `onStartColocated` callback immediately if the Session's colocated setup has already begun.
   * If not, `onStartColocated` will be called when colocated setup starts later on.
   * @param onStartColocated - Callback for starting colocation.
   */
  notifyOnStartColocated(onStartColocated: () => void): void {
    if (this.getOnStartColocated()) {
      onStartColocated()
    } else {
      this.onStartColocated.add(onStartColocated)
    }
  }

  /**
   * Returns true if the session has finished setting up and the lens experience is ready to start.
   * @returns True if the session has finished setting up and the lens experience is ready to start.
   */
  getIsReady(): boolean {
    return this._isReady
  }

  /**
   * Executes `onReady` immediately if the Session is ready, or will execute it later when the Session becomes ready.
   * @param onReady - Callback for when the session is ready.
   */
  notifyOnReady(onReady: () => void) {
    if (this.getIsReady()) {
      onReady()
    } else {
      this.onReady.add(onReady)
    }
  }

  /**
   * Returns true if the map exists.
   * @returns True if the map exists.
   */
  getMapExists(): boolean {
    return (
      this.locatedAtComponent !== null &&
      this.locatedAtComponent !== undefined &&
      this.locatedAtComponent.location !== null
    )
  }

  /**
   * Executes `onMapExists` immediately if the map exists.
   * @param onMapExists - Callback for when the map exists.
   */
  notifyOnMapExists(onMapExists: () => void) {
    if (this.getMapExists()) {
      onMapExists()
    } else {
      this.onMapExists.add(onMapExists)
    }
  }

  /**
   * @deprecated - this is no longer needed as getNearbyLocationStores now handles location retrieval logic.
   * locationId is no longer used and will not be set by default.
   * Executes `onLocationId` immediately if the locationId is found.
   * @param onLocationId - Callback for when the locationId is found.
   */
  notifyOnLocationId(onLocationId: () => void) {
    this.log.w("notifyOnLocationId is deprecated and will be removed in a future release")
    if (this.getColocatedMapId()) {
      onLocationId()
    } else {
      this.onLocationId.add(onLocationId)
    }
  }

  /**
   * Executes `onLocatedAtFound` immediately if the locatedAtComponent is found, or will execute it later when the component is found.
   * @param onLocatedAtFound - Callback for when the locatedAtComponent is found.
   */
  notifyOnLocatedAtFound(onLocatedAtFound: () => void) {
    if (this._isLocatedAtFound) {
      onLocatedAtFound()
    } else {
      this.onLocatedAtFound.add(onLocatedAtFound)
    }
  }

  /**
   * Returns the custom landmark being using, or null if not set.
   * @returns The custom landmark being using, or null if not set.
   */
  getCustomLandmark(): LocationAsset | null {
    return this.customLandmark
  }

  /**
   * Prepares SessionController to use a Mocked version of Connected Lenses.
   * Make sure to call this before calling init().
   * @param options - The mock session options.
   */
  prepareOfflineMode(options?: MockMultiplayerSessionConfig) {
    if (this._state !== State.NotInitialized) {
      this.log.e("Can't switch to offline after already initializing!")
      return
    }

    const mockModule = new MockConnectedLensModule()
    options = options || MockMultiplayerSessionConfig.createWithOneFrameLatency()
    mockModule.mockSessionOptions = options
    this.connectedLensModuleToUse = mockModule
    this._isSingleplayer = true
    this.setIsConnectionFirstJoiner(true)
  }

  /**
   * Checks if the current connection is the first joiner of the session.
   * @returns True if the current connection is the first joiner of the session.
   */
  getIsConnectionFirstJoiner(): boolean {
    if (this.isSingleplayer()) {
      return true
    }

    const sessionScopedStore = this.getSessionScopedStore()
    if (!sessionScopedStore) {
      return false
    }
    const firstJoinerConnectionId = sessionScopedStore.getString(FIRST_JOINER_CONNECTION_ID_KEY)
    return firstJoinerConnectionId === this.getLocalConnectionId()
  }

  /**
   * Sets whether the current connection is the first joiner of the session.
   * @param isConnectionFirstJoiner - Whether the current connection is the first joiner of the session.
   */
  setIsConnectionFirstJoiner(isConnectionFirstJoiner: boolean) {
    if (isConnectionFirstJoiner) {
      const sessionScopedStore = this.getSessionScopedStore()
      if (sessionScopedStore) {
        try {
          sessionScopedStore.putString(FIRST_JOINER_CONNECTION_ID_KEY, this.getLocalConnectionId())
        } catch (error) {
          this.log.e("error setting first joiner connection: " + error)
        }
      }
    }
  }

  /**
   * Get the current start mode.
   * Start Menu - Will show the start menu when the lens starts
   * Multiplayer - Will launch into multiplayer when the lens starts
   * Off - Will not show the start menu and will not launch into multiplayer. Use startWithStartMenu or startMultiplayer when ready.
   * @returns The current start mode.
   */
  getStartMode(): string | null {
    return this.startMode
  }

  /**
   * Starts the session with the start menu, allowing the user to select Multiplayer or Singleplayer.
   */
  startWithStartMenu() {
    StartModeController.getInstance().startWithMenu()
  }

  /**
   * Starts the session directly into Multiplayer mode.
   * This will not show the start menu, but will show error messages if any issues occur.
   * Will automatically retry at intervals if the connection fails.
   */
  startMultiplayer() {
    StartModeController.getInstance().startMultiplayer()
  }

  /**
   * Waits until a condition is true, then executes a callback.
   * @param condition - The condition to check.
   * @param callback - The callback to execute when the condition is true.
   * @param timeOutSeconds - The timeout in seconds.
   * @param onTimeout - The callback to execute if the timeout is reached.
   */
  private _waitUntilTrue(
    condition: () => boolean,
    callback: () => void,
    timeOutSeconds?: number,
    onTimeout?: () => void
  ) {
    const startTime = getTime()
    const evt = this.script.createEvent("UpdateEvent")
    evt.bind(() => {
      if (condition()) {
        this.script.removeEvent(evt)
        callback()
      } else if (timeOutSeconds !== undefined && timeOutSeconds !== null) {
        if (startTime + timeOutSeconds <= getTime()) {
          this.script.removeEvent(evt)
          if (onTimeout) {
            onTimeout()
          }
        }
      }
    })
  }
}

// These exports exist for javascript compatibility, and should not be used from typescript code.
;(global as any).sessionController = SessionController.getInstance()
