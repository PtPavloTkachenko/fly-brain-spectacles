import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {EventWrapper} from "./EventWrapper"
import {isSceneObject, isTransform} from "./NetworkUtils"
import {PropertyType} from "./PropertyType"
import {SessionController} from "./SessionController"
import {getEqualsCheckForStorageType, StorageTypes, StorageTypeToPrimitive} from "./StorageTypes"
import {SnapshotBuffer, SnapshotBufferOptions, SnapshotBufferOptionsObj} from "./SyncSnapshot"

const TAG = "StorageProperty"

/**
 * Provides classes and helper functions used for storing data in RealtimeStores.
 */
export class StorageProperty<TStorageType extends StorageTypes> {
  private log = new SyncKitLogger(TAG)

  /**
   * Key used to identify and store the property. This key matches defines how the property is accessed in a RealtimeStore.
   * It can also be used to identify the property in a {@link StoragePropertySet}.
   */
  key: string

  /**
   * used - by the property.
   */
  propertyType: TStorageType

  /**
   * If defined, this function is called to automatically update the property value each frame.
   */
  getterFunc: (() => StorageTypeToPrimitive[TStorageType]) | null = null

  /**
   * If defined, this function is called to automatically apply the property value.
   */
  setterFunc: ((val: StorageTypeToPrimitive[TStorageType]) => void) | null = null

  /**
   * If true, we have a value change that needs to be sent at the next opportunity.
   */
  needToSendUpdate = false

  /**
   * The function used to check for a change in the property value. It should return `true` if two values are equal, or reasonably close to equal.
   */
  equalsCheck: (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean =
    function (a, b): boolean {
      return a === b
    }

  /**
   * The current value that we believe to be synced across the network. In most simple cases, this is what you want to read from.
   */
  currentValue: StorageTypeToPrimitive[TStorageType] | null = null

  /**
   * The local value that can potentially be sent to the network at the next available chance. It may be the same as `currentValue`, but may not be.
   */
  pendingValue: StorageTypeToPrimitive[TStorageType] | null = null

  /**
   * The most recently changed local value, whether that's `current` or `pending`.
   * In most cases when you want a very up-to-date local value, this is what you want to read from.
   */
  currentOrPendingValue: StorageTypeToPrimitive[TStorageType] | null = null

  /**
   * Event triggered when the pending value changes.
   */
  onPendingValueChange: EventWrapper<[StorageTypeToPrimitive[TStorageType], StorageTypeToPrimitive[TStorageType]]> =
    new EventWrapper()

  /**
   * Event triggered when the `currentValue` is changed by a remote user.
   */
  onRemoteChange: EventWrapper<
    [
      StorageTypeToPrimitive[TStorageType],
      StorageTypeToPrimitive[TStorageType],
      ConnectedLensModule.RealtimeStoreUpdateInfo
    ]
  > = new EventWrapper()

  /**
   * Event triggered when the `currentValue` is changed by the local user.
   */
  onLocalChange: EventWrapper<[StorageTypeToPrimitive[TStorageType], StorageTypeToPrimitive[TStorageType]]> =
    new EventWrapper()

  /**
   * Event triggered when the `currentValue` is changed by any user (either local or remote).
   */
  onAnyChange: EventWrapper<
    [
      StorageTypeToPrimitive[TStorageType],
      StorageTypeToPrimitive[TStorageType],
      ConnectedLensModule.RealtimeStoreUpdateInfo | null
    ]
  > = new EventWrapper()

  /**
   * If greater than or equal to zero, this limits how often the property sends updates to the network about its value changing.
   * This is useful to avoid rate limiting when a value updates very frequently, for example if a position is changing every frame.
   * When using this feature, `currentValue` will only be updated when the value is actually sent to the network.
   * To get the most recent *local* version of a value, you can always check `currentOrPendingValue`.
   */
  sendsPerSecondLimit = -1

  /**
   * Can be used to manually mark the property dirty and skip equals check
   */
  markedDirty = false

  private _lastSendTime: number | null = null

  private _snapshotBuffer: SnapshotBuffer<TStorageType> | null = null

  /**
   * @param key - Key to identify and store the StorageProperty
   * @param propertyType - Use {@link StorageTypes | StorageTypes}
   * @param smoothingOptions - Options for automatically applied smoothing
   */
  constructor(key: string, propertyType: TStorageType, smoothingOptions?: SnapshotBufferOptions<TStorageType>) {
    this.key = key
    this.propertyType = propertyType

    const equalCheck = getEqualsCheckForStorageType<TStorageType>(this.propertyType)
    if (equalCheck) {
      this.equalsCheck = equalCheck
    }
    if (smoothingOptions) {
      this.setSmoothing(smoothingOptions)
    }
  }

  /**
   * @param smoothingOptions - Options for automatically applied smoothing
   */
  private setSmoothing(options?: SnapshotBufferOptions<TStorageType> | SnapshotBufferOptionsObj<TStorageType>) {
    if (options === null || options === undefined) {
      this._snapshotBuffer = null
    } else {
      options.storageType = options.storageType || this.propertyType
      this._snapshotBuffer = SnapshotBuffer.createFromOptions(options)
    }
  }

  /**
   * @param newValue - New value to apply
   * @param dontTriggerEvents - If true, events will not be triggered
   * @param updateInfo - Information about the update
   */
  applyRemoteValue(
    newValue: StorageTypeToPrimitive[TStorageType],
    dontTriggerEvents: boolean,
    updateInfo: ConnectedLensModule.RealtimeStoreUpdateInfo,
    isInitialValue: boolean
  ): void {
    const prevVal = this.currentValue
    this.currentValue = newValue
    this.pendingValue = newValue
    this.currentOrPendingValue = newValue

    if (this._snapshotBuffer) {
      if (isInitialValue) {
        this._snapshotBuffer.setCurrentValue(0, newValue)
      } else {
        if (!updateInfo) {
          throw new Error("No updateInfo provided for _applyRemoteValue")
        }
        if (!updateInfo.sentServerTimeMilliseconds) {
          throw new Error("No sentServerTimeMilliseconds provided for _applyRemoteValue")
        }

        this._snapshotBuffer.saveSnapshot(updateInfo.sentServerTimeMilliseconds * 0.001, newValue)
      }
    }

    if (this.setterFunc && (!this._snapshotBuffer || isInitialValue)) {
      try {
        this.setterFunc(newValue)
      } catch (error) {
        this.log.e("Error applying value " + this.key + ": " + error)
      }
    }

    if (!dontTriggerEvents) {
      this.onRemoteChange.trigger(this.currentValue, prevVal, updateInfo)
      this.onAnyChange.trigger(this.currentValue, prevVal, updateInfo)
    }
  }

  /**
   * @param newValue - New value to apply
   * @returns True if the value was changed
   */
  private _checkPendingValueChanged(newValue: StorageTypeToPrimitive[TStorageType]): boolean {
    if (
      newValue !== null &&
      newValue !== undefined &&
      (this.pendingValue === undefined || this.pendingValue === null || !this.equalsCheck(newValue, this.pendingValue))
    ) {
      const prevValue = this.pendingValue
      this.pendingValue = newValue
      this.currentOrPendingValue = newValue
      if (this._snapshotBuffer) {
        this._snapshotBuffer.setCurrentValue(SessionController.getInstance().getServerTimeInSeconds(), newValue)
      }
      this.onPendingValueChange.trigger(this.pendingValue, prevValue)
      return true
    }
    return false
  }

  /**
   * @param newValue - New value to apply
   * @returns True if the value was changed
   */
  private _checkCurrentValueChanged(newValue: StorageTypeToPrimitive[TStorageType]): boolean {
    this.pendingValue = newValue
    if (
      newValue !== null &&
      (this.markedDirty ||
        this.currentValue === undefined ||
        this.currentValue === null ||
        !this.equalsCheck(newValue, this.currentValue))
    ) {
      this.markedDirty = false
      const prevValue = this.currentValue
      this.currentValue = newValue
      this.currentOrPendingValue = newValue
      this.onLocalChange.trigger(this.currentValue, prevValue)
      this.onAnyChange.trigger(this.currentValue, prevValue, null)
      return true
    }
    return false
  }

  /**
   * Returns `true` if we are allowed to send updated values to the network based on the `sendsPerSecondLimit` and `timestamp`.
   * @param timestamp - Time in seconds
   * @returns True if we are allowed to send updated values to the network
   */
  checkWithinSendLimit(timestamp: number): boolean {
    if (this.sendsPerSecondLimit === 0) {
      return false
    } else if (this.sendsPerSecondLimit < 0 || this._lastSendTime === null) {
      return true
    }

    return this._lastSendTime + 1.0 / this.sendsPerSecondLimit <= timestamp
  }

  /**
   * @param timestamp - Time in seconds
   * @returns True if the value was changed
   */
  checkLocalValueChanged(): boolean {
    let newValue: StorageTypeToPrimitive[TStorageType]

    if (this.getterFunc) {
      newValue = this.getterFunc()
      if (newValue !== null && newValue !== undefined) {
        // Skip the update if we're using smoothing and the value hasn't changed
        if (this._snapshotBuffer) {
          const recentValue = this._snapshotBuffer.getMostRecentValue()
          if (recentValue !== null && recentValue !== undefined && this.equalsCheck(newValue, recentValue)) {
            return false
          }
        }
        // Try to set the pending value to the new value
        this._checkPendingValueChanged(newValue)
      }
    }

    return this._checkCurrentValueChanged(this.pendingValue)
  }

  /**
   * @returns True if the property has a snapshot buffer and is currently smoothing
   */
  isSmoothingEnabled(): boolean {
    return this._snapshotBuffer !== null
  }

  applySnapshotSmoothing(): void {
    if (this._snapshotBuffer) {
      const currentTimestamp = SessionController.getInstance().getServerTimeInSeconds()
      let newVal = this._snapshotBuffer.getLerpedValue(currentTimestamp + this._snapshotBuffer.interpolationTarget)
      if (newVal === null || newVal === undefined) {
        newVal = this.currentOrPendingValue
      }
      if (newVal !== null && newVal !== undefined) {
        try {
          if (this.setterFunc) {
            this.setterFunc(newVal)
          }
        } catch (error) {
          this.log.e("Error applying value " + this.key + ": " + error)
        }
      }
    }
  }

  /**
   * Sets the pending value to `newValue`. This value will be sent to the network at the end of the frame,
   * as soon as it's allowed to do so (we have permission to modify the SyncEntity, and `sendsPerSecondLimit` hasn't been reached).
   * @param newValue - New pending value to set
   */
  setPendingValue(newValue: StorageTypeToPrimitive[TStorageType]): void {
    if (this.getterFunc) {
      this.log.w("Pending value will be ignored for StorageProperty with getter func! key:" + this.key)
    }
    this._checkPendingValueChanged(newValue)
  }

  /**
   * @param newValue - New value to set
   */
  silentSetCurrentValue(newValue: StorageTypeToPrimitive[TStorageType]): void {
    this.currentValue = newValue
    this.pendingValue = newValue
    this.currentOrPendingValue = newValue
  }

  /**
   * Immediately set the current value. Only use this if you are sure that we have permission to modify the store.
   * @param store - Store to write value to
   * @param newValue - New value to set
   * @returns True if the value was changed
   */
  setValueImmediate(store: GeneralDataStore, newValue: StorageTypeToPrimitive[TStorageType]): boolean {
    if (this._checkCurrentValueChanged(newValue)) {
      this.putCurrentValue(store)
      return true
    }
    return false
  }

  /**
   * Helper function that writes a value to a `store`, given a `key` and {@link StorageType | StorageType}
   * @param store - Store to write value to
   * @param key - Key identifying the value
   * @param propertyType - the type of value
   * @param value - Value to set
   */
  private putStoreValueDynamic(
    store: GeneralDataStore,
    key: string,
    propertyType: StorageTypes,
    value: StorageTypeToPrimitive[TStorageType]
  ): void {
    let funcName = "put" + propertyType
    if (propertyType === StorageTypes.packedTransform) {
      funcName = "putVec4Array"
    }
    try {
      store[funcName](key, value)
    } catch (error) {
      this.log.e("Error putting property " + key + ", type " + propertyType + ", val: " + value + ". Error: " + error)
    }
  }

  /**
   * Helper function that reads a value from a `store`, given a `key` and {@link StorageType | StorageType}
   * @param store - Store to read value from
   * @param key - Key identifying the value
   * @param identifying - the type of value
   * @returns Value - found (or default value if none found)
   */
  static getStoreValueDynamic<T>(store: GeneralDataStore, key: string, propertyType: StorageTypes): T {
    let funcName = "get" + propertyType
    if (propertyType === StorageTypes.packedTransform) {
      funcName = "getVec4Array"
    }
    const newValue = store[funcName](key)
    return newValue
  }

  /**
   * @param store - Store to write value to
   * @param timeStamp - Time in seconds
   */
  putCurrentValue(store: GeneralDataStore, timeStamp?: number): void {
    this._lastSendTime = timeStamp === undefined ? getTime() : timeStamp
    this.putStoreValueDynamic(store, this.key, this.propertyType, this.currentValue)
  }

  /**
   * Creates a simple `StorageProperty` that should be updated manually.
   * @param key - Key to identify the property
   * @param propertyType - the type of value
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created manual StorageProperty
   */
  static manual<TPropertyType extends StorageTypes, TStartingValue extends StorageTypeToPrimitive[TPropertyType]>(
    key: string,
    propertyType: TPropertyType,
    startingValue?: TStartingValue,
    smoothingOptions?: SnapshotBufferOptions<TPropertyType> | SnapshotBufferOptionsObj<TPropertyType>
  ): StorageProperty<TPropertyType> {
    const prop = new StorageProperty(key, propertyType)
    prop.setPendingValue(startingValue)
    prop.setSmoothing(smoothingOptions)
    return prop
  }

  /**
   * Creates a simple `string` property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @returns Newly created StorageProperty
   */
  static manualString(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.string]
  ): StorageProperty<StorageTypes.string> {
    return StorageProperty.manual(key, StorageTypes.string, startingValue)
  }

  /**
   * Creates a simple `boolean` property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @returns Newly created StorageProperty
   */
  static manualBool(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.bool]
  ): StorageProperty<StorageTypes.bool> {
    return StorageProperty.manual(key, StorageTypes.bool, startingValue)
  }

  /**
   * Creates a simple `integer` property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @returns Newly created StorageProperty
   */
  static manualInt(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.int]
  ): StorageProperty<StorageTypes.int> {
    return StorageProperty.manual(key, StorageTypes.int, startingValue)
  }

  /**
   * Creates a simple `float` property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualFloat(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.float],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.float> | SnapshotBufferOptionsObj<StorageTypes.float>
  ): StorageProperty<StorageTypes.float> {
    return StorageProperty.manual(key, StorageTypes.float, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple `double` property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualDouble(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.double],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.double> | SnapshotBufferOptionsObj<StorageTypes.double>
  ): StorageProperty<StorageTypes.double> {
    return StorageProperty.manual(key, StorageTypes.double, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualVec2(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.vec2],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec2> | SnapshotBufferOptionsObj<StorageTypes.vec2>
  ): StorageProperty<StorageTypes.vec2> {
    return StorageProperty.manual(key, StorageTypes.vec2, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualVec3(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.vec3],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec3> | SnapshotBufferOptionsObj<StorageTypes.vec3>
  ): StorageProperty<StorageTypes.vec3> {
    return StorageProperty.manual(key, StorageTypes.vec3, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualMat2(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.mat2],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat2> | SnapshotBufferOptionsObj<StorageTypes.mat2>
  ): StorageProperty<StorageTypes.mat2> {
    return StorageProperty.manual(key, StorageTypes.mat2, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualMat3(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.mat3],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat3> | SnapshotBufferOptionsObj<StorageTypes.mat3>
  ): StorageProperty<StorageTypes.mat3> {
    return StorageProperty.manual(key, StorageTypes.mat3, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualMat4(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.mat4],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat4> | SnapshotBufferOptionsObj<StorageTypes.mat4>
  ): StorageProperty<StorageTypes.mat4> {
    return StorageProperty.manual(key, StorageTypes.mat4, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualVec4(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.vec4],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec4> | SnapshotBufferOptionsObj<StorageTypes.vec4>
  ): StorageProperty<StorageTypes.vec4> {
    return StorageProperty.manual(key, StorageTypes.vec4, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualQuat(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.quat],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.quat> | SnapshotBufferOptionsObj<StorageTypes.quat>
  ): StorageProperty<StorageTypes.quat> {
    return StorageProperty.manual(key, StorageTypes.quat, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualBoolArray(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.boolArray],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.boolArray> | SnapshotBufferOptionsObj<StorageTypes.boolArray>
  ): StorageProperty<StorageTypes.boolArray> {
    return StorageProperty.manual(key, StorageTypes.boolArray, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualStringArray(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.stringArray],
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.stringArray>
      | SnapshotBufferOptionsObj<StorageTypes.stringArray>
  ): StorageProperty<StorageTypes.stringArray> {
    return StorageProperty.manual(key, StorageTypes.stringArray, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualIntArray(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.intArray],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.intArray> | SnapshotBufferOptionsObj<StorageTypes.intArray>
  ): StorageProperty<StorageTypes.intArray> {
    return StorageProperty.manual(key, StorageTypes.intArray, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualFloatArray(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.floatArray],
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.floatArray>
      | SnapshotBufferOptionsObj<StorageTypes.floatArray>
  ): StorageProperty<StorageTypes.floatArray> {
    return StorageProperty.manual(key, StorageTypes.floatArray, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualDoubleArray(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.doubleArray],
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.doubleArray>
      | SnapshotBufferOptionsObj<StorageTypes.doubleArray>
  ): StorageProperty<StorageTypes.doubleArray> {
    return StorageProperty.manual(key, StorageTypes.doubleArray, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualVec2Array(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.vec2Array],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec2Array> | SnapshotBufferOptionsObj<StorageTypes.vec2Array>
  ): StorageProperty<StorageTypes.vec2Array> {
    return StorageProperty.manual(key, StorageTypes.vec2Array, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualVec3Array(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.vec3Array],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec3Array> | SnapshotBufferOptionsObj<StorageTypes.vec3Array>
  ): StorageProperty<StorageTypes.vec3Array> {
    return StorageProperty.manual(key, StorageTypes.vec3Array, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualVec4Array(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.vec4Array],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec4Array> | SnapshotBufferOptionsObj<StorageTypes.vec4Array>
  ): StorageProperty<StorageTypes.vec4Array> {
    return StorageProperty.manual(key, StorageTypes.vec4Array, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualMat2Array(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.mat2Array],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat2Array> | SnapshotBufferOptionsObj<StorageTypes.mat2Array>
  ): StorageProperty<StorageTypes.mat2Array> {
    return StorageProperty.manual(key, StorageTypes.mat2Array, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualMat3Array(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.mat3Array],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat3Array> | SnapshotBufferOptionsObj<StorageTypes.mat3Array>
  ): StorageProperty<StorageTypes.mat3Array> {
    return StorageProperty.manual(key, StorageTypes.mat3Array, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualMat4Array(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.mat4Array],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat4Array> | SnapshotBufferOptionsObj<StorageTypes.mat4Array>
  ): StorageProperty<StorageTypes.mat4Array> {
    return StorageProperty.manual(key, StorageTypes.mat4Array, startingValue, smoothingOptions)
  }

  /**
   * Creates a simple property that should be updated manually.
   * @param key - Key to identify the property
   * @param startingValue - Optional starting value to assign to the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static manualQuatArray(
    key: string,
    startingValue?: StorageTypeToPrimitive[StorageTypes.quatArray],
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.quatArray> | SnapshotBufferOptionsObj<StorageTypes.quatArray>
  ): StorageProperty<StorageTypes.quatArray> {
    return StorageProperty.manual(key, StorageTypes.quatArray, startingValue, smoothingOptions)
  }

  /**
   * Creates an automatically updated `StorageProperty` based on getter and setter functions.
   * @param key - Key to identify the property
   * @param propertyType - the type of value
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static auto<TPropertyType extends StorageTypes>(
    key: string,
    propertyType: TPropertyType,
    getterFunc: {(): StorageTypeToPrimitive[TPropertyType]},
    setterFunc: {(v: StorageTypeToPrimitive[TPropertyType]): void},
    smoothingOptions?: SnapshotBufferOptions<TPropertyType> | SnapshotBufferOptionsObj<TPropertyType>
  ): StorageProperty<TPropertyType> {
    const prop = new StorageProperty(key, propertyType)
    prop.getterFunc = getterFunc
    prop.setterFunc = setterFunc
    prop.setSmoothing(smoothingOptions)
    return prop
  }

  /**
   * Creates an automatically updated `boolean` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @returns Newly created StorageProperty
   */
  static autoBool(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.bool],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.bool]) => void
  ): StorageProperty<StorageTypes.bool> {
    return StorageProperty.auto(key, StorageTypes.bool, getterFunc, setterFunc)
  }

  /**
   * Creates an automatically updated `string` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @returns Newly created StorageProperty
   */
  static autoString(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.string],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.string]) => void
  ): StorageProperty<StorageTypes.string> {
    return StorageProperty.auto(key, StorageTypes.string, getterFunc, setterFunc)
  }

  /**
   * Creates an automatically updated `int` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @returns Newly created StorageProperty
   */
  static autoInt(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.int],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.int]) => void
  ): StorageProperty<StorageTypes.int> {
    return StorageProperty.auto(key, StorageTypes.int, getterFunc, setterFunc)
  }

  /**
   * Creates an automatically updated `float` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoFloat(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.float],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.float]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.float> | SnapshotBufferOptionsObj<StorageTypes.float>
  ): StorageProperty<StorageTypes.float> {
    return StorageProperty.auto(key, StorageTypes.float, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `double` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoDouble(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.double],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.double]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.double> | SnapshotBufferOptionsObj<StorageTypes.double>
  ): StorageProperty<StorageTypes.double> {
    return StorageProperty.auto(key, StorageTypes.double, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `vec2` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoVec2(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.vec2],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.vec2]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec2> | SnapshotBufferOptionsObj<StorageTypes.vec2>
  ): StorageProperty<StorageTypes.vec2> {
    return StorageProperty.auto(key, StorageTypes.vec2, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `vec3` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoVec3(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.vec3],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.vec3]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec3> | SnapshotBufferOptionsObj<StorageTypes.vec3>
  ): StorageProperty<StorageTypes.vec3> {
    return StorageProperty.auto(key, StorageTypes.vec3, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `vec4` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoVec4(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.vec4],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.vec4]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec4> | SnapshotBufferOptionsObj<StorageTypes.vec4>
  ): StorageProperty<StorageTypes.vec4> {
    return StorageProperty.auto(key, StorageTypes.vec4, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `quat` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoQuat(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.quat],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.quat]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.quat> | SnapshotBufferOptionsObj<StorageTypes.quat>
  ): StorageProperty<StorageTypes.quat> {
    return StorageProperty.auto(key, StorageTypes.quat, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `mat2` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoMat2(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.mat2],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.mat2]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat2> | SnapshotBufferOptionsObj<StorageTypes.mat2>
  ): StorageProperty<StorageTypes.mat2> {
    return StorageProperty.auto(key, StorageTypes.mat2, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `mat3` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoMat3(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.mat3],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.mat3]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat3> | SnapshotBufferOptionsObj<StorageTypes.mat3>
  ): StorageProperty<StorageTypes.mat3> {
    return StorageProperty.auto(key, StorageTypes.mat3, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `mat4` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoMat4(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.mat4],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.mat4]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat4> | SnapshotBufferOptionsObj<StorageTypes.mat4>
  ): StorageProperty<StorageTypes.mat4> {
    return StorageProperty.auto(key, StorageTypes.mat4, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `string[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoStringArray(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.stringArray],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.stringArray]) => void,
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.stringArray>
      | SnapshotBufferOptionsObj<StorageTypes.stringArray>
  ): StorageProperty<StorageTypes.stringArray> {
    return StorageProperty.auto(key, StorageTypes.stringArray, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `boolean[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoBoolArray(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.boolArray],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.boolArray]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.boolArray> | SnapshotBufferOptionsObj<StorageTypes.boolArray>
  ): StorageProperty<StorageTypes.boolArray> {
    return StorageProperty.auto(key, StorageTypes.boolArray, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `float[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoFloatArray(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.floatArray],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.floatArray]) => void,
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.floatArray>
      | SnapshotBufferOptionsObj<StorageTypes.floatArray>
  ): StorageProperty<StorageTypes.floatArray> {
    return StorageProperty.auto(key, StorageTypes.floatArray, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `double[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoDoubleArray(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.doubleArray],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.doubleArray]) => void,
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.doubleArray>
      | SnapshotBufferOptionsObj<StorageTypes.doubleArray>
  ): StorageProperty<StorageTypes.doubleArray> {
    return StorageProperty.auto(key, StorageTypes.doubleArray, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `int[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoIntArray(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.intArray],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.intArray]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.intArray> | SnapshotBufferOptionsObj<StorageTypes.intArray>
  ): StorageProperty<StorageTypes.intArray> {
    return StorageProperty.auto(key, StorageTypes.intArray, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `vec2[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoVec2Array(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.vec2Array],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.vec2Array]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec2Array> | SnapshotBufferOptionsObj<StorageTypes.vec2Array>
  ): StorageProperty<StorageTypes.vec2Array> {
    return StorageProperty.auto(key, StorageTypes.vec2Array, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `vec3[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoVec3Array(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.vec3Array],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.vec3Array]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec3Array> | SnapshotBufferOptionsObj<StorageTypes.vec3Array>
  ): StorageProperty<StorageTypes.vec3Array> {
    return StorageProperty.auto(key, StorageTypes.vec3Array, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `vec4[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoVec4Array(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.vec4Array],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.vec4Array]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec4Array> | SnapshotBufferOptionsObj<StorageTypes.vec4Array>
  ): StorageProperty<StorageTypes.vec4Array> {
    return StorageProperty.auto(key, StorageTypes.vec4Array, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `quat[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoQuatArray(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.quatArray],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.quatArray]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.quatArray> | SnapshotBufferOptionsObj<StorageTypes.quatArray>
  ): StorageProperty<StorageTypes.quatArray> {
    return StorageProperty.auto(key, StorageTypes.quatArray, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `mat2[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoMat2Array(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.mat2Array],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.mat2Array]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat2Array> | SnapshotBufferOptionsObj<StorageTypes.mat2Array>
  ): StorageProperty<StorageTypes.mat2Array> {
    return StorageProperty.auto(key, StorageTypes.mat2Array, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `mat3[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoMat3Array(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.mat3Array],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.mat3Array]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat3Array> | SnapshotBufferOptionsObj<StorageTypes.mat3Array>
  ): StorageProperty<StorageTypes.mat3Array> {
    return StorageProperty.auto(key, StorageTypes.mat3Array, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated `mat4[]` property based on getter and setter functions.
   * @param key - Key to identify the property
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static autoMat4Array(
    key: string,
    getterFunc: () => StorageTypeToPrimitive[StorageTypes.mat4Array],
    setterFunc: (val: StorageTypeToPrimitive[StorageTypes.mat4Array]) => void,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.mat4Array> | SnapshotBufferOptionsObj<StorageTypes.mat4Array>
  ): StorageProperty<StorageTypes.mat4Array> {
    return StorageProperty.auto(key, StorageTypes.mat4Array, getterFunc, setterFunc, smoothingOptions)
  }

  /**
   * Creates an automatically updated property based on a target object and property name.
   * The `propName` should be the name of a property on the `target` object.
   * @param key - Key to identify the property
   * @param target - Target object to watch
   * @param propName - Name of a property on `target` that should be watched
   * @param propertyType - the type of value
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static wrapProperty<
    TObject extends Record<TKey, TValue>,
    TKey extends keyof TObject,
    TPropertyType extends StorageTypes,
    TValue extends TObject[TKey] & StorageTypeToPrimitive[TPropertyType]
  >(
    key: string,
    target: TObject,
    propName: TKey,
    propertyType: TPropertyType,
    smoothingOptions?: SnapshotBufferOptions<TPropertyType>
  ): StorageProperty<TPropertyType> {
    const storageProp = new StorageProperty(key, propertyType)
    storageProp.setterFunc = wrapPropertyWriter<TObject, TKey, TValue>(target, propName)
    storageProp.getterFunc = wrapPropertyReader<TObject, TKey, TValue>(target, propName)
    storageProp.setSmoothing(smoothingOptions)
    return storageProp
  }

  /**
   * Creates an automatically updated property that mirrors a {@link Transform | Transform} position/rotation/scale.
   * @param getterFunc - Function that returns the current local value for the property
   * @param setterFunc - Function that applies incoming new values for the property
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static forTransform(
    permissiveTransform: Transform | SceneObject | Component,
    positionPropertyType: PropertyType,
    rotationPropertyType: PropertyType,
    scalePropertyType: PropertyType,
    smoothingOptions?:
      | SnapshotBufferOptions<StorageTypes.packedTransform>
      | SnapshotBufferOptionsObj<StorageTypes.packedTransform>
  ): StorageProperty<StorageTypes.packedTransform> {
    const transform = getTransformHelper(permissiveTransform)

    const positionGetter = StorageProperty.forPositionGetterFun(positionPropertyType, transform)
    const positionSetter = StorageProperty.forPositionSetterFun(positionPropertyType, transform)
    const rotationGetter = StorageProperty.forRotationGetterFun(rotationPropertyType, transform)
    const rotationSetter = StorageProperty.forRotationSetterFun(rotationPropertyType, transform)
    const scaleGetter = StorageProperty.forScaleGetterFun(scalePropertyType, transform)
    const scaleSetter = StorageProperty.forScaleSetterFun(scalePropertyType, transform)

    const transformGetterFunc = () => {
      const positionVec3 = positionGetter()
      const positionVec4 = new vec4(positionVec3.x, positionVec3.y, positionVec3.z, 0)

      const rotationQuat = rotationGetter()
      const rotationVec4 = new vec4(rotationQuat.x, rotationQuat.y, rotationQuat.z, rotationQuat.w)

      const scaleVec3 = scaleGetter()
      const scaleVec4 = new vec4(scaleVec3.x, scaleVec3.y, scaleVec3.z, 0)

      return [positionVec4, rotationVec4, scaleVec4]
    }

    const transformSetterFunc = (newValue: vec4[]) => {
      const positionVec4 = newValue[0]
      const positionVec3 = new vec3(positionVec4.x, positionVec4.y, positionVec4.z)
      positionSetter(positionVec3)

      const rotationVec4 = newValue[1]
      const rotationQuat = new quat(rotationVec4.w, rotationVec4.x, rotationVec4.y, rotationVec4.z)
      rotationSetter(rotationQuat)

      const scaleVec4 = newValue[2]
      const scaleVec3 = new vec3(scaleVec4.x, scaleVec4.y, scaleVec4.z)
      scaleSetter(scaleVec3)
    }

    return StorageProperty.auto(
      "transformAllData" + "_" + transform.getSceneObject().name,
      StorageTypes.packedTransform,
      transformGetterFunc,
      transformSetterFunc,
      smoothingOptions
    )
  }

  /**
   * @param transform -
   * @param propertyType -
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static forPosition(
    permissiveTransform: Transform | SceneObject | Component,
    propertyType: PropertyType,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec3> | SnapshotBufferOptionsObj<StorageTypes.vec3>
  ): StorageProperty<StorageTypes.vec3> {
    const transform = getTransformHelper(permissiveTransform)
    const getter = StorageProperty.forPositionGetterFun(propertyType, transform)
    const setter = StorageProperty.forPositionSetterFun(propertyType, transform)
    return StorageProperty.auto(
      "position" + propertyType + "_" + transform.getSceneObject().name,
      StorageTypes.vec3,
      getter,
      setter,
      smoothingOptions
    )
  }

  /**
   * @param transform -
   * @param propertyType -
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static forRotation(
    permissiveTransform: Transform | SceneObject | Component,
    propertyType: PropertyType,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.quat> | SnapshotBufferOptionsObj<StorageTypes.quat>
  ): StorageProperty<StorageTypes.quat> {
    const transform = getTransformHelper(permissiveTransform)
    const getter = StorageProperty.forRotationGetterFun(propertyType, transform)
    const setter = StorageProperty.forRotationSetterFun(propertyType, transform)
    return StorageProperty.auto(
      "rotation" + propertyType + "_" + transform.getSceneObject().name,
      StorageTypes.quat,
      getter,
      setter,
      smoothingOptions
    )
  }

  /**
   *
   * @param transform -
   * @param propertyType -
   * @param smoothingOptions - Options for automatically applied smoothing
   * @returns Newly created StorageProperty
   */
  static forScale(
    permissiveTransform: Transform | SceneObject | Component,
    propertyType: PropertyType,
    smoothingOptions?: SnapshotBufferOptions<StorageTypes.vec3> | SnapshotBufferOptionsObj<StorageTypes.vec3>
  ): StorageProperty<StorageTypes.vec3> {
    const transform = getTransformHelper(permissiveTransform)
    const getter = StorageProperty.forScaleGetterFun(propertyType, transform)
    const setter = StorageProperty.forScaleSetterFun(propertyType, transform)
    return StorageProperty.auto(
      "scale" + propertyType + "_" + transform.getSceneObject().name,
      StorageTypes.vec3,
      getter,
      setter,
      smoothingOptions
    )
  }

  private static forScaleGetterFun(propertyType: PropertyType, transform: Transform): () => vec3 {
    switch (propertyType) {
      case PropertyType.None:
        return () => {
          return vec3.zero()
        }
      case PropertyType.Local:
        return () => {
          return transform.getLocalScale()
        }
      case PropertyType.World:
        return () => {
          return transform.getWorldScale()
        }
      case PropertyType.Location: {
        const locationTransform = getLocationTransform(transform)
        return () => {
          const worldTransform = transform.getWorldTransform()
          const locationInvertedTransform = locationTransform.getInvertedWorldTransform()
          const transformFromLocation = locationInvertedTransform.mult(worldTransform)
          return scaleFromMat4(transformFromLocation)
        }
      }
      default:
        throw new Error("Invalid PropertyType")
    }
  }

  private static forPositionGetterFun(propertyType: PropertyType, transform: Transform): () => vec3 {
    switch (propertyType) {
      case PropertyType.None:
        return () => {
          return vec3.zero()
        }
      case PropertyType.Local:
        return () => {
          return transform.getLocalPosition()
        }
      case PropertyType.World:
        return () => {
          return transform.getWorldPosition()
        }
      case PropertyType.Location: {
        const locationTransform = getLocationTransform(transform)
        return () => {
          const worldTransform = transform.getWorldTransform()
          const locationInvertedTransform = locationTransform.getInvertedWorldTransform()
          const transformFromLocation = locationInvertedTransform.mult(worldTransform)
          return new vec3(
            transformFromLocation.column3.x,
            transformFromLocation.column3.y,
            transformFromLocation.column3.z
          )
        }
      }
      default:
        throw new Error("Invalid PropertyType")
    }
  }

  private static forRotationGetterFun(propertyType: PropertyType, transform: Transform): () => quat {
    switch (propertyType) {
      case PropertyType.None:
        return () => {
          return quat.quatIdentity()
        }
      case PropertyType.Local:
        return () => {
          return transform.getLocalRotation()
        }
      case PropertyType.World:
        return () => {
          return transform.getWorldRotation()
        }
      case PropertyType.Location: {
        const locationTransform = getLocationTransform(transform)
        return () => {
          const worldRotation = transform.getWorldRotation()
          const locationWorldRotation = locationTransform.getWorldRotation()
          const locationInverseRotation = locationWorldRotation.invert()
          const rotationQuat = locationInverseRotation.multiply(worldRotation)
          return rotationQuat
        }
      }
      default:
        throw new Error("Invalid PropertyType")
    }
  }

  private static forPositionSetterFun(propertyType: PropertyType, transform: Transform): (value: vec3) => void {
    switch (propertyType) {
      case PropertyType.None:
        return () => {}
      case PropertyType.Local:
        return (value: vec3) => {
          return transform.setLocalPosition(value)
        }
      case PropertyType.World:
        return (value: vec3) => {
          return transform.setWorldPosition(value)
        }
      case PropertyType.Location: {
        const locationTransform = getLocationTransform(transform)
        return (value: vec3) => {
          const locationWorldTransform = locationTransform.getWorldTransform()
          const worldPosition = locationWorldTransform.multiplyPoint(value)
          transform.setWorldPosition(worldPosition)
        }
      }
      default:
        throw new Error("Invalid PropertyType")
    }
  }

  private static forRotationSetterFun(propertyType: PropertyType, transform: Transform): (value: quat) => void {
    switch (propertyType) {
      case PropertyType.None:
        return () => {}
      case PropertyType.Local:
        return (value: quat) => {
          return transform.setLocalRotation(value)
        }
      case PropertyType.World:
        return (value: quat) => {
          return transform.setWorldRotation(value)
        }
      case PropertyType.Location: {
        const locationTransform = getLocationTransform(transform)
        return (value: quat) => {
          const locationRotation = locationTransform.getWorldRotation()
          const worldRotation = locationRotation.multiply(value)
          transform.setWorldRotation(worldRotation)
        }
      }
      default:
        throw new Error("Invalid PropertyType")
    }
  }

  private static forScaleSetterFun(propertyType: PropertyType, transform: Transform): (value: vec3) => void {
    switch (propertyType) {
      case PropertyType.None:
        return () => {}
      case PropertyType.Local:
        return (val: vec3) => {
          return transform.setLocalScale(val)
        }
      case PropertyType.World:
        return (val: vec3) => {
          return transform.setWorldScale(val)
        }
      case PropertyType.Location: {
        const locationTransform = getLocationTransform(transform)
        return (val: vec3) => {
          const locationScaleMatrix = locationTransform.getWorldTransform()
          const relativeScaleMatrix = mat4.fromScale(val)
          const worldScaleMatrix = locationScaleMatrix.mult(relativeScaleMatrix)
          const worldScale = scaleFromMat4(worldScaleMatrix)
          transform.setWorldScale(worldScale)
        }
      }
      default:
        throw new Error("Invalid PropertyType")
    }
  }

  /**
   * Creates an automatically updated property that mirrors a {@link Text| Text}'s `text` property.
   * @param to - watch
   * @returns Newly created StorageProperty
   */
  static forTextText(text: Text): StorageProperty<StorageTypes.string> {
    return StorageProperty.wrapProperty("text_text", text, "text", StorageTypes.string)
  }

  /**
   * Creates an automatically updated property that mirrors a value on a {@link Material | Material}'s `mainPass`.
   * @param material - Material to watch
   * @param propertyName - Name of a property on the `material`
   * @param storageType - the type of value
   * @returns Newly created StorageProperty
   */
  static forMaterialProperty<TStorageType extends StorageTypes>(
    material: Material,
    propertyName: string,
    storageType: TStorageType
  ): StorageProperty<TStorageType> {
    return StorageProperty.wrapProperty(
      "mat_" + material.name + "_" + propertyName,
      material.mainPass,
      propertyName,
      storageType
    )
  }

  /**
   * Creates an automatically updated property that mirrors a value on a {@link MaterialMeshVisual | MaterialMeshVisual}'s `mainMaterial`.
   * There is also an option to clone the material in-place.
   * @param visual - Visual to watch
   * @param propertyName - Name of a property on the `visual`
   * @param storageType - the type of value
   * @param clone - If `true`, the material will be cloned and applied back to the visual. Useful if multiple objects use the same material
   * @returns Newly created StorageProperty
   */
  static forMeshVisualProperty<TStorageType extends StorageTypes>(
    visual: MaterialMeshVisual,
    propertyName: string,
    storageType: TStorageType,
    clone?: boolean
  ): StorageProperty<TStorageType> {
    if (clone) {
      visual.mainMaterial = visual.mainMaterial.clone()
    }
    return StorageProperty.forMaterialProperty(visual.mainMaterial, propertyName, storageType)
  }

  /**
   * Creates an automatically updated property that mirrors the `baseColor` of a {@link MaterialMeshVisual | MaterialMeshVisual}.
   * @param visual - Visual to watch
   * @param clone - If `true`, the material will be cloned and applied back to the visual. Useful if multiple objects use the same material
   * @returns Newly created StorageProperty
   */
  static forMeshVisualBaseColor(visual: MaterialMeshVisual, clone?: boolean): StorageProperty<StorageTypes.vec4> {
    return StorageProperty.forMeshVisualProperty(visual, "baseColor", StorageTypes.vec4, clone)
  }
}

/**
 * @param target - Target object
 * @returns The Transform of the target object
 */
function getTransformHelper(target: Transform | SceneObject | Component): Transform | null {
  if (isNull(target)) {
    return null
  }

  if (isTransform(target)) {
    return target
  }

  if (target.getTransform) {
    return target.getTransform()
  }

  return null
}

/**
 * @param target - Target object
 * @returns The Transform of the LocatedAt object which is the ancestor of the target object
 */
function getLocationTransform(target: Transform | SceneObject | Component): Transform {
  const targetSceneObject = getSceneObjectHelper(target)
  const locationObject = findLocatedAtComponent(targetSceneObject)
  const locationTransform = getTransformHelper(locationObject)
  if (locationTransform === null) {
    throw new Error(`Could not find LocatedAtComponent for Location sync'd object ${targetSceneObject.name}`)
  }
  return locationTransform
}

/**
 * @param target - Target object
 * @returns The SceneObject of the target object
 */
function getSceneObjectHelper(target: Transform | SceneObject | Component): SceneObject | null {
  if (isNull(target)) {
    return null
  }
  if (isSceneObject(target)) {
    return target
  }
  if (isTransform(target)) {
    return target.getSceneObject()
  }
  if (target.getSceneObject) {
    return target.getSceneObject()
  }
  return null
}

/**
 * @param object - Target object
 * @returns The LocatedAtComponent that is the ancestor of the target object
 */
function findLocatedAtComponent(object: SceneObject): LocatedAtComponent {
  if (isNull(object)) {
    return null
  }

  for (const component of object.getComponents("Component.LocatedAtComponent")) {
    return component
  }

  return findLocatedAtComponent(object.getParent())
}

/**
 * Returns a function that returns the current value of a property on the target object
 * @param obj - Target object
 * @param propName - Name of property to read from
 * @returns Function that returns the property `propName` on `obj`.
 */
function wrapPropertyReader<
  TObject extends Record<TKey, TValue>,
  TKey extends keyof TObject,
  TValue extends TObject[TKey]
>(obj: TObject, propName: TKey): () => TValue {
  return () => {
    return obj[propName] as TValue
  }
}

/**
 * Returns a function that sets the value of a property on the target object
 * @param obj - Target object
 * @param propName - Name of property to write to
 * @returns Function that sets the property `propName` on `obj` to the passed in argument.
 */
function wrapPropertyWriter<
  TObject extends Record<TKey, TValue>,
  TKey extends keyof TObject,
  TValue extends TObject[TKey]
>(obj: TObject, propName: TKey): (value: TValue) => void {
  return (value: TValue) => {
    obj[propName] = value
  }
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are exactly equal
 */
export function exactCompare<T>(a: T, b: T): boolean {
  return a === b
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are exactly equal
 */
export function exactArrayCompare<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    if (!exactCompare(a[i], b[i])) {
      return false
    }
  }
  return true
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function floatCompare(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function floatArrayCompare(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    if (!floatCompare(a[i], b[i])) {
      return false
    }
  }
  return true
}

const VEC_COMPARE_EPSILON = 0.000001
/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function vecCompare(a: vec2, b: vec2): boolean
export function vecCompare(a: vec3, b: vec3): boolean
export function vecCompare(a: vec4, b: vec4): boolean
export function vecCompare(a: vec2 | vec3 | vec4, b: vec2 | vec3 | vec4): boolean {
  if (a instanceof vec2 && b instanceof vec2) {
    return a.distanceSquared(b) < VEC_COMPARE_EPSILON
  }
  if (a instanceof vec3 && b instanceof vec3) {
    return a.distanceSquared(b) < VEC_COMPARE_EPSILON
  }
  if (a instanceof vec4 && b instanceof vec4) {
    return a.distanceSquared(b) < VEC_COMPARE_EPSILON
  }
  return false
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function quatArrayCompare(a: quat[], b: quat[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    if (!quatCompare(a[i], b[i])) {
      return false
    }
  }
  return true
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function vecArrayCompare(a: vec2[], b: vec2[]): boolean
export function vecArrayCompare(a: vec3[], b: vec3[]): boolean
export function vecArrayCompare(a: vec4[], b: vec4[]): boolean
export function vecArrayCompare(a: (vec2 | vec3 | vec4)[], b: (vec2 | vec3 | vec4)[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]
    const bi = b[i]
    if (ai instanceof vec2 && bi instanceof vec2) {
      if (!vecCompare(ai, bi)) return false
    } else if (ai instanceof vec3 && bi instanceof vec3) {
      if (!vecCompare(ai, bi)) return false
    } else if (ai instanceof vec4 && bi instanceof vec4) {
      if (!vecCompare(ai, bi)) return false
    } else {
      return false
    }
  }
  return true
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function matArrayCompare(a: mat2[], b: mat2[]): boolean
export function matArrayCompare(a: mat3[], b: mat3[]): boolean
export function matArrayCompare(a: mat4[], b: mat4[]): boolean
export function matArrayCompare(a: (mat2 | mat3 | mat4)[], b: (mat2 | mat3 | mat4)[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]
    const bi = b[i]
    if (ai instanceof mat2 && bi instanceof mat2) {
      if (!matCompare(ai, bi)) return false
    } else if (ai instanceof mat3 && bi instanceof mat3) {
      if (!matCompare(ai, bi)) return false
    } else if (ai instanceof mat4 && bi instanceof mat4) {
      if (!matCompare(ai, bi)) return false
    } else {
      return false
    }
  }
  return true
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function packedTransformCompare(a: vec4[], b: vec4[]): boolean {
  const position0 = a[0]
  const position1 = b[0]
  const rotation0 = quatFromVec4(a[1])
  const rotation1 = quatFromVec4(b[1])
  const scale0 = a[2]
  const scale1 = b[2]

  return vecCompare(position0, position1) && quatCompare(rotation0, rotation1) && vecCompare(scale0, scale1)
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function quatCompare(a: quat, b: quat): boolean {
  return a.dot(b) >= 0.999
}

/**
 * @param a - First value
 * @param b - Second value
 * @returns True if the two values are approximately equal
 */
export function matCompare(a: mat2, b: mat2): boolean
export function matCompare(a: mat3, b: mat3): boolean
export function matCompare(a: mat4, b: mat4): boolean
export function matCompare(a: mat2 | mat3 | mat4, b: mat2 | mat3 | mat4): boolean {
  if (a instanceof mat2 && b instanceof mat2) {
    return a.equal(b)
  }
  if (a instanceof mat3 && b instanceof mat3) {
    return a.equal(b)
  }
  if (a instanceof mat4 && b instanceof mat4) {
    return a.equal(b)
  }
  return false
}

/**
 * @param startValue - Start value
 * @param endValue - End value
 * @param startTangent - Start tangent
 * @param endTangent - End tangent
 * @param t - Interpolation amount
 * @returns Interpolated value
 */
export function cubicInterpolate(
  startValue: number,
  endValue: number,
  startTangent: number,
  endTangent: number,
  t: number
): number {
  const t2 = t * t
  const t3 = t2 * t

  return (
    (2 * t3 - 3 * t2 + 1) * startValue +
    (t3 - 2 * t2 + t) * startTangent +
    (-2 * t3 + 3 * t2) * endValue +
    (t3 - t2) * endTangent
  )
}

/**
 * @param startValue - Start value
 * @param endValue - End value
 * @param startTangent - Start tangent
 * @param endTangent - End tangent
 * @param t - Interpolation amount
 * @returns Interpolated value
 */
export function vec2CubicInterpolate(
  startValue: vec2,
  endValue: vec2,
  startTangent: vec2,
  endTangent: vec2,
  t: number
): vec2 {
  const newVec = new vec2(0, 0)
  newVec.x = cubicInterpolate(startValue.x, endValue.x, startTangent.x, endTangent.x, t)
  newVec.y = cubicInterpolate(startValue.y, endValue.y, startTangent.y, endTangent.y, t)
  return newVec
}

/**
 * @param startValue - Start value
 * @param endValue - End value
 * @param startTangent - Start tangent
 * @param endTangent - End tangent
 * @param t - Interpolation amount
 * @returns Interpolated value
 */
export function vec3CubicInterpolate(
  startValue: vec3,
  endValue: vec3,
  startTangent: vec3,
  endTangent: vec3,
  t: number
): vec3 {
  const newVec = new vec3(0, 0, 0)
  newVec.x = cubicInterpolate(startValue.x, endValue.x, startTangent.x, endTangent.x, t)
  newVec.y = cubicInterpolate(startValue.y, endValue.y, startTangent.y, endTangent.y, t)
  newVec.z = cubicInterpolate(startValue.z, endValue.z, startTangent.z, endTangent.z, t)
  return newVec
}

/**
 * @param startValue - Start value
 * @param endValue - End value
 * @param startTangent - Start tangent
 * @param endTangent - End tangent
 * @param t - Interpolation amount
 * @returns Interpolated value
 */
export function vec4CubicInterpolate(
  startValue: vec4,
  endValue: vec4,
  startTangent: vec4,
  endTangent: vec4,
  t: number
): vec4 {
  const newVec = new vec4(0, 0, 0, 0)
  newVec.x = cubicInterpolate(startValue.x, endValue.x, startTangent.x, endTangent.x, t)
  newVec.y = cubicInterpolate(startValue.y, endValue.y, startTangent.y, endTangent.y, t)
  newVec.z = cubicInterpolate(startValue.z, endValue.z, startTangent.z, endTangent.z, t)
  newVec.w = cubicInterpolate(startValue.w, endValue.w, startTangent.w, endTangent.w, t)
  return newVec
}

/**
 * @param startValue - Start value
 * @param endValue - End value
 * @param startTangent - Start tangent
 * @param endTangent - End tangent
 * @param t - Interpolation amount
 * @returns Interpolated value
 */
export function squad(startValue: quat, endValue: quat, startTangent: quat, endTangent: quat, t: number): quat {
  const slerpP0P1 = quat.slerp(startValue, endValue, t)
  const slerpA0A1 = quat.slerp(startTangent, endTangent, t)
  return quat.slerp(slerpP0P1, slerpA0A1, 2 * t * (1 - t))
}

/**
 * computes the tangent at point1, when alpha =
 *  0: uniform
 *  0.5: centripetal
 *  1.0: chordal
 * @param point0 - Point 0
 * @param point1 - Point 1
 * @param point2 - Point 2
 * @param alpha - Alpha value
 * @param d0 - Distance between point0 and point1
 * @param d1 - Distance between point1 and point2
 * @returns Tangent value
 */
export function tangent(point0: number, point1: number, point2: number, alpha: number, d0: number, d1: number): number {
  d0 = d0 || Math.abs(point0 - point1)
  d1 = d1 || Math.abs(point2 - point1)
  const t0 = 0
  const t1 = t0 + Math.pow(d0, alpha)
  const t2 = t1 + Math.pow(d1, alpha)

  return ((point1 - point0) / (t1 - t0) - (point2 - point0) / (t2 - t0) + (point2 - point1) / (t2 - t1)) * (t2 - t1)
}

/**
 * @param point0 - Point 0
 * @param point1 - Point 1
 * @param point2 - Point 2
 * @param alpha - Alpha value
 * @returns Tangent value
 */
export function vec2Tangent(point0: vec2, point1: vec2, point2: vec2, alpha: number): vec2 {
  const d0 = point0.distance(point1)
  const d1 = point1.distance(point2)
  const newVec = new vec2(0, 0)
  newVec.x = tangent(point0.x, point1.x, point2.x, alpha, d0, d1)
  newVec.y = tangent(point0.y, point1.y, point2.y, alpha, d0, d1)
  return newVec
}

/**
 * @param point0 - Point 0
 * @param point1 - Point 1
 * @param point2 - Point 2
 * @param alpha - Alpha value
 * @returns Tangent value
 */
export function vec3Tangent(point0: vec3, point1: vec3, point2: vec3, alpha: number): vec3 {
  const d0 = point0.distance(point1)
  const d1 = point1.distance(point2)
  const newVec = new vec3(0, 0, 0)
  newVec.x = tangent(point0.x, point1.x, point2.x, alpha, d0, d1)
  newVec.y = tangent(point0.y, point1.y, point2.y, alpha, d0, d1)
  newVec.z = tangent(point0.z, point1.z, point2.z, alpha, d0, d1)
  return newVec
}

/**
 * @param point0 - Point 0
 * @param point1 - Point 1
 * @param point2 - Point 2
 * @param alpha - Alpha value
 * @returns Tangent value
 */
export function vec4Tangent(point0: vec4, point1: vec4, point2: vec4, alpha: number): vec4 {
  const d0 = point0.distance(point1)
  const d1 = point1.distance(point2)
  const newVec = new vec4(0, 0, 0, 0)
  newVec.x = tangent(point0.x, point1.x, point2.x, alpha, d0, d1)
  newVec.y = tangent(point0.y, point1.y, point2.y, alpha, d0, d1)
  newVec.z = tangent(point0.z, point1.z, point2.z, alpha, d0, d1)
  newVec.w = tangent(point0.w, point1.w, point2.w, alpha, d0, d1)
  return newVec
}

/**
 * @param q0 - Quaternion 0
 * @param q1 - Quaternion 1
 * @param q2 - Quaternion 2
 * @returns Inner quadrangle quaternion
 */
export function computeInnerQuadrangleQuaternion(q0: quat, q1: quat, q2: quat): quat {
  const q1Inv = q1.invert()
  const q1Invq0 = q1Inv.multiply(q0)
  q1Invq0.normalize()
  const qa = q1.multiply(quat.slerp(quat.quatIdentity(), q1Invq0, -0.25))
  const q1Invq2 = q1Inv.multiply(q2)
  q1Invq2.normalize()
  const qb = q1.multiply(quat.slerp(quat.quatIdentity(), q1Invq2, -0.25))
  const innerQuadrangle = quat.slerp(qa, qb, 0.5)
  return q1.multiply(innerQuadrangle)
}

/**
 * Returns the number between `a` and `b` determined by the ratio `t`
 * @param a - Lower Bound
 * @param b - Upper Bound
 * @param t - Ratio [0-1]
 * @returns Number - between `a` and `b` determined by ratio `t`
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * @param a - Vector to interpolate from
 * @param b - Vector to interpolate to
 * @param t - Ratio [0-1]
 * @returns Interpolated vector
 */
export function vec2Lerp(a: vec2, b: vec2, t: number): vec2 {
  return vec2.lerp(a, b, t)
}

/**
 * @param a - Vector to interpolate from
 * @param b - Vector to interpolate to
 * @param t - Ratio [0-1]
 * @returns Interpolated vector
 */
export function vec3Lerp(a: vec3, b: vec3, t: number): vec3 {
  return vec3.lerp(a, b, t)
}

/**
 * @param a - Vector to interpolate from
 * @param b - Vector to interpolate to
 * @param t - Ratio [0-1]
 * @returns Interpolated vector
 */
export function vec4Lerp(a: vec4, b: vec4, t: number): vec4 {
  return vec4.lerp(a, b, t)
}

/**
 * @param a - The packed transform to interpolate from
 * @param b - The packed transform to interpolate to
 * @param t - Ratio [0-1]
 * @returns Interpolated packed transform
 */
export function packedTransformLerp(a: vec4[], b: vec4[], t: number): vec4[] {
  const position0 = a[0]
  const position1 = b[0]
  const rotation0 = quatFromVec4(a[1])
  const rotation1 = quatFromVec4(b[1])
  const scale0 = a[2]
  const scale1 = b[2]

  return [
    vec4Lerp(position0, position1, t),
    vec4FromQuat(quatSlerp(rotation0, rotation1, t)),
    vec4Lerp(scale0, scale1, t)
  ]
}

function vec4FromQuat(q: quat) {
  return new vec4(q.x, q.y, q.z, q.w)
}

function quatFromVec4(v: vec4) {
  return new quat(v.w, v.x, v.y, v.z)
}

function scaleFromMat4(mat: mat4) {
  return new vec3(mat.column0.length, mat.column1.length, mat.column2.length)
}

/**
 * @param a - The quaternion to interpolate from
 * @param b - The quaternion to interpolate to
 * @param t - Ratio [0-1]
 * @returns Interpolated quaternion
 */
export function quatSlerp(a: quat, b: quat, t: number): quat {
  return quat.slerp(a, b, t)
}

;(global as any).StorageProperty = StorageProperty
