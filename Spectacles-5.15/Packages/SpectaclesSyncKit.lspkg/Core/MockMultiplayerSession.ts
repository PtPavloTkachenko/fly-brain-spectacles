import {createUUID} from "../Utils/UUID"
import {LatencySetting, MockMultiplayerSessionConfig, MockUserConfig} from "./MockMultiplayerSessionConfig"

export class MockUserInfo implements ConnectedLensModule.UserInfo {
  bitmojiAvatarId: string = ""
  connectionId: string = ""
  displayName: string = ""
  joinServerTimeMilliseconds: number = 0
  userId: string = ""

  getTypeName(): string {
    return "MockUserInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockUserInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export const EMPTY_MOCK_USER: MockUserInfo = new MockUserInfo()

export class MockConnectedLensModule implements ConnectedLensModule {
  readonly name: string = "MockConnectedLensModule"
  readonly uniqueIdentifier: string = createUUID()

  joinContext = null
  mockSession: MockMultiplayerSession = null
  mockSessionOptions: MockMultiplayerSessionConfig

  createSession(sessionOptions: ConnectedLensSessionOptions): void {
    this.mockSession = new MockMultiplayerSession(sessionOptions, this.mockSessionOptions)
    this.mockSession.startSessionCreationUsingLatency()
  }

  shareSession(): void {
    throw new Error("Method not implemented.")
  }

  recordScore(): void {
    throw new Error("Method not implemented.")
  }

  showLeaderboard(): void {
    throw new Error("Method not implemented.")
  }

  getTypeName(): string {
    return "MockConnectedLensModule"
  }

  isOfType(type: string): boolean {
    return type === "MockConnectedLensModule"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockRealtimeStoreCreationInfo implements ConnectedLensModule.RealtimeStoreCreationInfo {
  allowOwnershipTakeOver: boolean
  lastUpdatedServerTimestamp: number
  ownerInfo: ConnectedLensModule.UserInfo
  persistence: RealtimeStoreCreateOptions.Persistence
  sentServerTimeMilliseconds: number
  storeId: string

  getTypeName(): string {
    return "MockRealtimeStoreCreationInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockRealtimeStoreCreationInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockRealtimeStoreOwnershipUpdateInfo implements ConnectedLensModule.RealtimeStoreOwnershipUpdateInfo {
  sentServerTimeMilliseconds: number

  getTypeName(): string {
    return "MockRealtimeStoreOwnershipUpdateInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockRealtimeStoreOwnershipUpdateInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockRealtimeStoreUpdateInfo implements ConnectedLensModule.RealtimeStoreUpdateInfo {
  sentServerTimeMilliseconds: number
  updaterInfo: ConnectedLensModule.UserInfo

  getTypeName(): string {
    return "MockRealtimeStoreUpdateInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockRealtimeStoreUpdateInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockRealtimeStoreKeyRemovalInfo implements ConnectedLensModule.RealtimeStoreKeyRemovalInfo {
  key: string
  removerInfo: ConnectedLensModule.UserInfo
  sentServerTimeMilliseconds: number
  store: GeneralDataStore

  getTypeName(): string {
    return "MockRealtimeStoreKeyRemovalInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockRealtimeStoreKeyRemovalInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockRealtimeStoreDeleteInfo implements ConnectedLensModule.RealtimeStoreDeleteInfo {
  deleterInfo: ConnectedLensModule.UserInfo
  sentServerTimeMilliseconds: number

  getTypeName(): string {
    return "MockRealtimeStoreDeleteInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockRealtimeStoreDeleteInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockRealtimeStoreEntry {
  private _options: RealtimeStoreCreateOptions = null
  private _creationInfo: MockRealtimeStoreCreationInfo = null

  store: GeneralDataStore = null
  owner: ConnectedLensModule.UserInfo = null

  lastUpdatedTimestamp: number | null = null

  constructor(options: RealtimeStoreCreateOptions, timestamp: number) {
    this._options = options
    this.owner = EMPTY_MOCK_USER

    if (options.initialStore) {
      // TODO: would be better to shallow copy the store, but it's not easy :(
      this.store = options.initialStore
    } else {
      this.store = GeneralDataStore.create()
    }

    this._creationInfo = new MockRealtimeStoreCreationInfo()
    this._creationInfo.allowOwnershipTakeOver = options.allowOwnershipTakeOver
    this._creationInfo.sentServerTimeMilliseconds = timestamp
    this._creationInfo.persistence = options.persistence
    this._creationInfo.storeId = options.storeId
    this._creationInfo.ownerInfo = this.owner

    this.lastUpdatedTimestamp = timestamp
  }

  getStoreInfo(): ConnectedLensModule.RealtimeStoreCreationInfo {
    this._creationInfo.lastUpdatedServerTimestamp = altIfNullOrUndef(
      this.lastUpdatedTimestamp,
      this._creationInfo.sentServerTimeMilliseconds
    )
    this._creationInfo.ownerInfo = this.owner
    return this._creationInfo
  }

  setLastUpdatedTimestamp(timestamp: number) {
    this.lastUpdatedTimestamp = timestamp
  }
}

export class MockStoreHandler {
  storeEntries: MockRealtimeStoreEntry[] = []

  private _localUserInfo: ConnectedLensModule.UserInfo = null

  private _getTimeStamp: () => number

  onRealtimeStoreCreated: (
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
    creationInfo: ConnectedLensModule.RealtimeStoreCreationInfo
  ) => void
  onRealtimeStoreDeleted: (store: GeneralDataStore, deleteInfo: ConnectedLensModule.RealtimeStoreDeleteInfo) => void
  onRealtimeStoreKeyRemoved: (removalInfo: ConnectedLensModule.RealtimeStoreKeyRemovalInfo) => void
  onRealtimeStoreOwnershipUpdated: (
    store: GeneralDataStore,
    ownerInfo: ConnectedLensModule.UserInfo,
    ownershipUpdateInfo: ConnectedLensModule.RealtimeStoreOwnershipUpdateInfo
  ) => void
  onRealtimeStoreUpdated: (
    store: GeneralDataStore,
    key: string,
    updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo
  ) => void

  constructor(timeStampGetter: () => number) {
    this._getTimeStamp = timeStampGetter
  }

  setLocalUserInfo(userInfo: ConnectedLensModule.UserInfo) {
    this._localUserInfo = userInfo
  }

  private findMatchingStoreEntryIndex(store: GeneralDataStore): number | null {
    const index = this.storeEntries.findIndex((s) => s.store.isSame(store))
    return index === -1 ? null : index
  }

  private findMatchingStoreEntry(store: GeneralDataStore): MockRealtimeStoreEntry | null {
    return this.storeEntries.find((s) => s.store.isSame(store)) || null
  }

  manualMarkRealtimeStoreUpdated(store: GeneralDataStore, key: string, overrideTimestamp: number | null = null) {
    const entry = this.findMatchingStoreEntry(store)
    if (!assertWithError(Boolean(entry), "Could not find matching store entry")) {
      return
    }
    this.notifyRealtimeStoreUpdated(entry, key, overrideTimestamp)
  }

  manualMarkRealtimeStoreKeyRemoved(store: GeneralDataStore, key: string, overrideTimestamp: number | null = null) {
    const entry = this.findMatchingStoreEntry(store)
    if (!assertWithError(Boolean(entry), "Could not find matching store entry")) {
      return
    }
    this.notifyRealtimeStoreKeyRemoved(entry, key, overrideTimestamp)
  }

  getAllStores(): GeneralDataStore[] {
    return this.storeEntries.map((s) => s.store)
  }

  createRealtimeStore(
    options: RealtimeStoreCreateOptions,
    onSuccess: (store: GeneralDataStore) => void,
    _onError: (message: string) => void,
    overrideTimestamp: number | null = null
  ): void {
    const newStoreEntry = new MockRealtimeStoreEntry(options, this._getTimeStamp())
    this.storeEntries.push(newStoreEntry)
    const shouldStartOwned = options.ownership === RealtimeStoreCreateOptions.Ownership.Owned
    if (shouldStartOwned) {
      newStoreEntry.owner = this._localUserInfo
    }
    onSuccess(newStoreEntry.store)
    this.notifyRealtimeStoreCreated(newStoreEntry, overrideTimestamp)
    if (shouldStartOwned) {
      this.notifyUpdateRealtimeStoreOwnership(newStoreEntry, overrideTimestamp)
    }
  }

  deleteRealtimeStore(
    store: GeneralDataStore,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void,
    overrideTimestamp: number | null = null
  ): void {
    const entryIndex = this.findMatchingStoreEntryIndex(store)
    if (!assertWithError(entryIndex !== null, "Could not find matching store entry", onError)) {
      return
    }
    const entry = this.storeEntries[entryIndex]
    this.storeEntries.splice(entryIndex, 1)
    onSuccess(entry.store)
    this.notifyRealtimeStoreDeleted(entry, overrideTimestamp)
  }

  requestRealtimeStoreOwnership(
    store: GeneralDataStore,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void,
    overrideTimestamp: number | null = null
  ): void {
    const entry = this.findMatchingStoreEntry(store)
    if (!assertWithError(Boolean(entry), "Could not find matching store entry", onError)) {
      return
    }
    entry.owner = this._localUserInfo
    onSuccess(entry.store)
    this.notifyUpdateRealtimeStoreOwnership(entry, overrideTimestamp)
  }

  clearOwnership(
    store: GeneralDataStore,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void,
    overrideTimestamp: number | null = null
  ) {
    const entry = this.findMatchingStoreEntry(store)
    if (!assertWithError(Boolean(entry), "Could not find matching store entry", onError)) {
      return
    }
    entry.owner = EMPTY_MOCK_USER
    onSuccess(store)
    this.notifyUpdateRealtimeStoreOwnership(entry, overrideTimestamp)
  }

  getRealtimeStoreInfo(store: GeneralDataStore): ConnectedLensModule.RealtimeStoreCreationInfo {
    const entry = this.findMatchingStoreEntry(store)
    if (!assertWithError(Boolean(entry), "Could not find matching store entry")) {
      return
    }
    return entry.getStoreInfo()
  }

  private notifyRealtimeStoreCreated(storeEntry: MockRealtimeStoreEntry, timestamp: number | null = null) {
    const creationInfo = new MockRealtimeStoreCreationInfo()

    creationInfo.allowOwnershipTakeOver = storeEntry.getStoreInfo().allowOwnershipTakeOver
    creationInfo.ownerInfo = storeEntry.owner
    creationInfo.persistence = storeEntry.getStoreInfo().persistence
    creationInfo.storeId = storeEntry.getStoreInfo().storeId

    creationInfo.sentServerTimeMilliseconds = this.getTimestampOrDefault(timestamp)
    creationInfo.lastUpdatedServerTimestamp = creationInfo.sentServerTimeMilliseconds

    this.onRealtimeStoreCreated(storeEntry.store, storeEntry.owner, creationInfo)
  }

  private notifyRealtimeStoreDeleted(storeEntry: MockRealtimeStoreEntry, timestamp: number | null = null) {
    const deletionInfo = new MockRealtimeStoreDeleteInfo()
    deletionInfo.deleterInfo = this._localUserInfo
    deletionInfo.sentServerTimeMilliseconds = this.getTimestampOrDefault(timestamp)

    this.onRealtimeStoreDeleted(storeEntry.store, deletionInfo)
  }

  private notifyRealtimeStoreUpdated(storeEntry: MockRealtimeStoreEntry, key: string, timestamp: number | null = null) {
    const updateInfo = new MockRealtimeStoreUpdateInfo()
    updateInfo.sentServerTimeMilliseconds = this.getTimestampOrDefault(timestamp)
    updateInfo.updaterInfo = this._localUserInfo

    this.onRealtimeStoreUpdated(storeEntry.store, key, updateInfo)
  }

  private notifyRealtimeStoreKeyRemoved(
    storeEntry: MockRealtimeStoreEntry,
    key: string,
    timestamp: number | null = null
  ) {
    const removalInfo = new MockRealtimeStoreKeyRemovalInfo()
    removalInfo.sentServerTimeMilliseconds = this.getTimestampOrDefault(timestamp)
    removalInfo.removerInfo = this._localUserInfo
    removalInfo.key = key
    removalInfo.store = storeEntry.store

    this.onRealtimeStoreKeyRemoved(removalInfo)
  }

  private notifyUpdateRealtimeStoreOwnership(storeEntry: MockRealtimeStoreEntry, timestamp: number | null = null) {
    const updateInfo = new MockRealtimeStoreOwnershipUpdateInfo()
    updateInfo.sentServerTimeMilliseconds = this.getTimestampOrDefault(timestamp)

    this.onRealtimeStoreOwnershipUpdated(storeEntry.store, storeEntry.owner, updateInfo)
  }

  private getTimestampOrDefault(timestamp: number | null) {
    return nullOrUndef(timestamp) ? this._getTimeStamp() : timestamp
  }
}

export class MockConnectionInfo implements ConnectedLensModule.ConnectionInfo {
  externalUsersInfo: ConnectedLensModule.UserInfo[]
  hostUserInfo: ConnectedLensModule.UserInfo
  localUserInfo: ConnectedLensModule.UserInfo
  realtimeStores: GeneralDataStore[]
  realtimeStoresCreationInfos: ConnectedLensModule.RealtimeStoreCreationInfo[]
  sessionMembershipToken: string = ""

  getTypeName(): string {
    return "MockConnectionInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockConnectionInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockHostUpdateInfo implements ConnectedLensModule.HostUpdateInfo {
  sentServerTimeMilliseconds: number
  userInfo: ConnectedLensModule.UserInfo

  getTypeName(): string {
    return "MockHostUpdateInfo"
  }

  isOfType(type: string): boolean {
    return type === "MockHostUpdateInfo"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

export class MockMultiplayerSession implements MultiplayerSession {
  private _options: ConnectedLensSessionOptions = null
  private _storeHandler: MockStoreHandler = null
  private _delayHelper: DelayHelper = null

  mockLocalUserInfo: ConnectedLensModule.UserInfo = null

  testOptions: MockMultiplayerSessionConfig

  constructor(
    options: ConnectedLensSessionOptions,
    testOptions: MockMultiplayerSessionConfig = new MockMultiplayerSessionConfig()
  ) {
    this._options = options
    this.testOptions = testOptions

    this._delayHelper = new DelayHelper()

    // Set up realtime store manager
    this._storeHandler = new MockStoreHandler(() => this.getServerTimestamp())

    // Set up realtime store callbacks
    this._storeHandler.onRealtimeStoreCreated = (store, ownerInfo, creationInfo) => {
      if (options.onRealtimeStoreCreated) {
        options.onRealtimeStoreCreated(this, store, ownerInfo, creationInfo)
      }
    }
    this._storeHandler.onRealtimeStoreDeleted = (store, deletionInfo) => {
      if (options.onRealtimeStoreDeleted) {
        options.onRealtimeStoreDeleted(this, store, deletionInfo)
      }
    }
    this._storeHandler.onRealtimeStoreKeyRemoved = (removalInfo) => {
      if (options.onRealtimeStoreKeyRemoved) {
        options.onRealtimeStoreKeyRemoved(this, removalInfo)
      }
    }
    this._storeHandler.onRealtimeStoreOwnershipUpdated = (store, ownerInfo, updateInfo) => {
      if (options.onRealtimeStoreOwnershipUpdated) {
        options.onRealtimeStoreOwnershipUpdated(this, store, ownerInfo, updateInfo)
      }
    }
    this._storeHandler.onRealtimeStoreUpdated = (store, key, updateInfo) => {
      if (options.onRealtimeStoreUpdated) {
        options.onRealtimeStoreUpdated(this, store, key, updateInfo)
      }
    }
  }

  get activeUserCount() {
    return 1
  }

  get activeUsersInfo() {
    return [this.mockLocalUserInfo]
  }

  get allRealtimeStores(): GeneralDataStore[] {
    return this._storeHandler.getAllStores()
  }

  startSessionCreationUsingLatency() {
    let isLatencyReady = false
    let hasStarted = false

    const refresh = () => {
      if (!hasStarted && isLatencyReady) {
        hasStarted = true
        this.handleSessionCreation()
      }
    }

    this.latencyHelper(this.testOptions.connectionLatency, () => {
      isLatencyReady = true
      refresh()
    })
  }

  startConnectionUsingLatency() {
    const needsDisplayName = nullOrUndef(this.testOptions.mockUserInfo?.displayName)
    let displayName: string = null
    let isLatencyReady = false
    let hasStarted = false

    const refresh = () => {
      if (!hasStarted && isLatencyReady && (!needsDisplayName || !nullOrUndef(displayName))) {
        hasStarted = true
        this.handleConnectionStart(displayName)
      }
    }

    this.latencyHelper(this.testOptions.connectionLatency, () => {
      isLatencyReady = true
      refresh()
    })

    if (needsDisplayName) {
      global.userContextSystem.requestDisplayName((name) => {
        displayName = name
        refresh()
      })
    }
  }

  private handleSessionCreation() {
    this.notifySessionCreation()

    this.startConnectionUsingLatency()
  }

  private handleConnectionStart(displayName?: string) {
    // Set up mock local user
    this.mockLocalUserInfo = this.createMockUserInfo(this.testOptions.mockUserInfo, displayName)

    this._storeHandler.setLocalUserInfo(this.mockLocalUserInfo)

    this.notifyOnConnected()
    this.notifyUserJoinedSession()
    this.notifyHostUpdated()
  }

  private createMockUserInfo(mockUserConfig?: MockUserConfig, displayName?: string): MockUserInfo {
    const userInfo = new MockUserInfo()
    userInfo.connectionId = altIfNullOrUndef(
      mockUserConfig?.connectionId,
      "mock_connection_id_" + Math.floor(MathUtils.randomRange(0, 9999))
    )
    userInfo.userId = altIfNullOrUndef(mockUserConfig?.userId, "mock_user_id")
    userInfo.displayName = altIfNullOrUndef(mockUserConfig?.displayName, displayName)

    userInfo.joinServerTimeMilliseconds = this.getServerTimestamp()
    return userInfo
  }

  private notifySessionCreation() {
    if (this._options.onSessionCreated) {
      this._options.onSessionCreated(this, ConnectedLensSessionOptions.SessionCreationType.MultiplayerReceiver)
    }
  }

  private notifyOnConnected() {
    if (this._options.onConnected) {
      const connectionInfo = new MockConnectionInfo()
      connectionInfo.externalUsersInfo = []
      connectionInfo.hostUserInfo = this.mockLocalUserInfo
      connectionInfo.localUserInfo = this.mockLocalUserInfo
      connectionInfo.realtimeStores = []
      connectionInfo.realtimeStoresCreationInfos = []

      this._options.onConnected(this, connectionInfo)
    }
  }

  private notifyUserJoinedSession() {
    if (this._options.onUserJoinedSession) {
      this._options.onUserJoinedSession(this, this.mockLocalUserInfo)
    }
  }

  private notifyHostUpdated() {
    if (this._options.onHostUpdated) {
      const updateInfo = new MockHostUpdateInfo()
      updateInfo.sentServerTimeMilliseconds = this.getServerTimestamp()
      updateInfo.userInfo = this.mockLocalUserInfo
      this._options.onHostUpdated(this, updateInfo)
    }
  }

  private latencyHelper(latencySetting: LatencySetting, callback: (overrideTimestamp: number) => void) {
    const initialTimestamp = this.getServerTimestamp()
    const latency = LatencySetting.getLatencyValue(latencySetting)
    this._delayHelper.waitAndCall(latency, () => {
      callback(initialTimestamp)
    })
  }

  clearRealtimeStoreOwnership(
    store: GeneralDataStore,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void
  ): void {
    this.latencyHelper(this.testOptions.realtimeStoreLatency, (timestamp) => {
      this._storeHandler.clearOwnership(store, onSuccess, onError, timestamp)
    })
  }

  createRealtimeStore(
    options: RealtimeStoreCreateOptions,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void
  ): void {
    this.latencyHelper(this.testOptions.realtimeStoreLatency, (timestamp) => {
      this._storeHandler.createRealtimeStore(options, onSuccess, onError, timestamp)
    })
  }

  deleteRealtimeStore(
    store: GeneralDataStore,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void
  ): void {
    this.latencyHelper(this.testOptions.realtimeStoreLatency, (timestamp) => {
      this._storeHandler.deleteRealtimeStore(store, onSuccess, onError, timestamp)
    })
  }

  requestRealtimeStoreOwnership(
    store: GeneralDataStore,
    onSuccess: (store: GeneralDataStore) => void,
    onError: (message: string) => void
  ): void {
    this.latencyHelper(this.testOptions.realtimeStoreLatency, (timestamp) => {
      this._storeHandler.requestRealtimeStoreOwnership(store, onSuccess, onError, timestamp)
    })
  }

  getLocalUserId(localUserIdCallback: (userId: string) => void): void {
    this.latencyHelper(this.testOptions.localUserInfoLatency, () => {
      localUserIdCallback(this.mockLocalUserInfo.userId)
    })
  }

  getLocalUserInfo(localUserInfoCallback: (userInfo: ConnectedLensModule.UserInfo) => void): void {
    this.latencyHelper(this.testOptions.localUserInfoLatency, () => {
      localUserInfoCallback(this.mockLocalUserInfo)
    })
  }

  getSnapchatUser(userInfo: ConnectedLensModule.UserInfo, callback: (user: SnapchatUser) => void): void {
    // Singleplayer/offline mock: no SnapchatUser context is available. Pass null as discussed.
    // Use the same latency helper as other user info calls for consistency.
    this.latencyHelper(this.testOptions.localUserInfoLatency, () => {
      callback(null)
    })
  }

  getSafeSnapchatUser(userInfo: ConnectedLensModule.UserInfo, callback: (user: SnapchatUser) => void): void {
    this.getSnapchatUser(userInfo, callback)
  }

  getRealtimeStoreInfo(store: GeneralDataStore): ConnectedLensModule.RealtimeStoreCreationInfo {
    return this._storeHandler.getRealtimeStoreInfo(store)
  }

  getServerTimestamp(): number {
    return Date.now()
  }

  sendMessage(_message: string): void {
    // Real MultiplayerSession does not echo a sender's message back to themselves — it is only
    // delivered to remote peers. In solo mode there are no remote peers, so sendMessage is a no-op.
    // NetworkMessageWrapper.sendMessage handles local-sender dispatch on its own.
  }

  // Note: timeout is not implemented
  sendMessageWithTimeout(message: string): void {
    this.sendMessage(message)
  }

  manualMarkStoreUpdated(store: GeneralDataStore, key: string) {
    this._storeHandler.manualMarkRealtimeStoreUpdated(store, key, this.getServerTimestamp())
  }

  manualMarkStoreKeyRemoved(store: GeneralDataStore, key: string) {
    this._storeHandler.manualMarkRealtimeStoreKeyRemoved(store, key, this.getServerTimestamp())
  }

  deletePersistedValue(): void {
    throw new Error("Method not implemented.")
  }
  deleteStoredValue(): void {
    throw new Error("Method not implemented.")
  }
  getAppInstanceId(): string {
    throw new Error("Method not implemented.")
  }
  getLastUpdatedServerTimestamp(): number {
    throw new Error("Method not implemented.")
  }
  getMatchId(): string {
    throw new Error("Method not implemented.")
  }
  getPersistedAsset(): void {
    throw new Error("Method not implemented.")
  }
  getPersistedValue(): void {
    throw new Error("Method not implemented.")
  }
  getStoredValue(): void {
    throw new Error("Method not implemented.")
  }
  isValidTimestamp(): boolean {
    throw new Error("Method not implemented.")
  }
  leave(): void {
    throw new Error("Method not implemented.")
  }
  listPersistedValues(): void {
    throw new Error("Method not implemented.")
  }
  listStoredValues(): void {
    throw new Error("Method not implemented.")
  }
  sendMessageBytes(): void {
    throw new Error("Method not implemented.")
  }
  sendMessageBytesWithTimeout(): void {
    throw new Error("Method not implemented.")
  }
  sendRPC(): void {
    throw new Error("Method not implemented.")
  }
  setPersistedAsset(): void {
    throw new Error("Method not implemented.")
  }
  setPersistedValue(): void {
    throw new Error("Method not implemented.")
  }
  setStoredValue(): void {
    throw new Error("Method not implemented.")
  }

  getTypeName(): string {
    return "MockMultiplayerSession"
  }

  isOfType(type: string): boolean {
    return type === "MockMultiplayerSession"
  }

  isSame(other: ScriptObject): boolean {
    return this === other
  }
}

class DelayHelper {
  private _script: ScriptComponent = null

  constructor() {
    this._script = global.scene.createSceneObject("DelayHelper").createComponent("ScriptComponent")
  }

  waitAndCall(delay: number, callback: (eventData: DelayedCallbackEvent) => void): DelayedCallbackEvent | null {
    if (delay <= 0) {
      callback(null)
    }
    return this.createDelayedEvent(callback, delay, true)
  }

  createDelayedEvent(
    callback: (eventData: DelayedCallbackEvent) => void = null,
    delay = -1,
    onlyOnce = false
  ): DelayedCallbackEvent {
    const evt = this._script.createEvent("DelayedCallbackEvent")
    if (callback) {
      if (onlyOnce) {
        evt.bind((e) => {
          this._script.removeEvent(e)
          callback(e)
        })
      } else {
        evt.bind((e) => callback(e))
      }
    }
    if (delay >= 0) {
      evt.reset(delay)
    }
    return evt
  }
}

function nullOrUndef(value: unknown): boolean {
  return value === null || value === undefined
}

function altIfNullOrUndef<T>(value: T, alt: T) {
  return nullOrUndef(value) ? alt : value
}

function assertWithError(condition: boolean, message: string, onError?: (message: string) => void): boolean {
  if (condition) {
    return true
  }
  if (onError) {
    onError(message)
  } else {
    print(message)
  }
  return false
}
