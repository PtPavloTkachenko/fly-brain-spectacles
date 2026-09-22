import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {
  ArrayStorageTypePrimitive,
  getBaseStorageType,
  getLerpForStorageType,
  isArrayType,
  NonArrayStorageTypePrimitive,
  StorageTypes,
  StorageTypeToPrimitive,
} from "./StorageTypes"

const TAG = "SnapshotBuffer"

export class SyncSnapshot<T extends StorageTypeToPrimitive[StorageTypes]> {
  time: number
  value: T

  /**
   * @param timestamp - Time in seconds
   * @param value - Value to store
   */
  constructor(timestamp: number, value: T) {
    this.time = timestamp
    this.value = value
  }
}

/**
 * @param storageType - Type of storage to use for interpolation
 * @param interpolationTarget - Time delta in local seconds to target (default = -0.25)
 * @param lerpFunc - Function used for interpolating
 * @param size - Max number of snapshots stored (default = 20)
 */
export type SnapshotBufferOptionsObj<TStorageType extends StorageTypes> = {
  storageType?: TStorageType
  interpolationTarget?: number
  lerpFunc?: ((a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]) | null
  size?: number
}

export class SnapshotBufferOptions<TStorageType extends StorageTypes> {
  storageType: TStorageType
  interpolationTarget: number | null
  lerpFunc: ((a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]) | null
  size: number | null

  constructor(optionDic: SnapshotBufferOptionsObj<TStorageType>) {
    if (optionDic) {
      for (const k in optionDic) {
        if (Object.prototype.hasOwnProperty.call(optionDic, k)) {
          this[k] = optionDic[k]
        }
      }
    }
  }
}

/**
 * Used to track received network values and interpolate based on timestamps.
 */
export class SnapshotBuffer<TStorageType extends StorageTypes> {
  private log = new SyncKitLogger(TAG)

  private snapshots: SyncSnapshot<StorageTypeToPrimitive[TStorageType]>[]
  private size: number
  interpolationTarget: number
  private allowExtrapolation: boolean
  private lerpFunc: ((a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]) | null
  private mostRecentValue: StorageTypeToPrimitive[TStorageType] | null
  private _storageType: TStorageType | null
  private _isArrayType: boolean
  private _lerpBuffer: ArrayStorageTypePrimitive<TStorageType> | null = null

  /**
   * @param options - Options for the buffer
   */
  constructor(
    options?: SnapshotBufferOptions<TStorageType> | SnapshotBufferOptionsObj<TStorageType>,
  ) {
    options = options || {}

    this.snapshots = []
    this.size = options.size === undefined ? 20 : options.size
    this.interpolationTarget =
      options.interpolationTarget === undefined
        ? -0.25
        : options.interpolationTarget
    this.allowExtrapolation = false
    this.lerpFunc = options.lerpFunc
    this.mostRecentValue = null
    this._storageType = options.storageType
    this._isArrayType = false
    this._lerpBuffer = []

    if (this._storageType) {
      this._isArrayType = isArrayType(this._storageType)
      if (!this.lerpFunc) {
        const baseType = getBaseStorageType(this._storageType);
        // we accept any lerpFunction from options, but we need to typecast this one to the correct type for the given storage type given we only provide lerp functions for primitive values.
        this.lerpFunc = getLerpForStorageType(baseType as TStorageType)
      }
    }
  }

  /**
   * @param options - Options for the buffer
   * @returns SnapshotBuffer
   */
  static createFromOptions<U extends StorageTypes>(
    options?: SnapshotBufferOptions<U> | SnapshotBufferOptionsObj<U>,
  ): SnapshotBuffer<U> {
    return new SnapshotBuffer<U>(options)
  }

  /**
   * @param timestamp - Time in local seconds
   * @param value - Value to store
   * @returns Snapshot of the value
   */
  saveSnapshot(timestamp: number, value: StorageTypeToPrimitive[TStorageType] | undefined): SyncSnapshot<StorageTypeToPrimitive[TStorageType]> {
    // TODO: use a circular buffer
    if (this.snapshots.length >= this.size) {
      this.snapshots.shift()
    }
    if (
      this.snapshots.length > 0 &&
      this.snapshots[this.snapshots.length - 1].time > timestamp
    ) {
      this.log.w(
        "Recieved timestamp out of order: " +
          this.snapshots[this.snapshots.length - 1].time +
          ">" +
          timestamp,
      )
      return
    }
    // TODO: pool and reuse snapshots
    const newValue = value
    const snapshot = new SyncSnapshot(timestamp, newValue)
    this.snapshots.push(snapshot)
    return snapshot
  }

  /**
   * @param timestamp - Time in seconds
   * @returns The index of the snapshot before the given timestamp
   */
  private findNearestIndexBefore(timestamp: number): number {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].time < timestamp) {
        return i
      }
    }
    return -1
  }

  /**
   * @param currentTime - Time in seconds
   * @param value - Value to set
   * @returns Snapshot of the value
   */
  setCurrentValue(currentTime: number, value: StorageTypeToPrimitive[TStorageType]): SyncSnapshot<StorageTypeToPrimitive[TStorageType]> {
    this.snapshots = []
    this.mostRecentValue = value
    return this.saveSnapshot(currentTime, value)
  }

  /**
   * @returns Most recent value
   */
  getMostRecentValue(): StorageTypeToPrimitive[TStorageType] | null {
    return this.mostRecentValue
  }

  /**
   * @param timestamp - Time in seconds
   * @returns Value at the given time
   */
  getLerpedValue(timestamp: number): StorageTypeToPrimitive[TStorageType] | null {
    const beforeInd = this.findNearestIndexBefore(timestamp)
    if (beforeInd === -1) {
      return null
    }

    let before: SyncSnapshot<StorageTypeToPrimitive[TStorageType]> = this.snapshots[beforeInd]
    let after: SyncSnapshot<StorageTypeToPrimitive[TStorageType]> | null = null

    // Check if we can interpolate
    if (beforeInd < this.snapshots.length - 1) {
      after = this.snapshots[beforeInd + 1]
      const t = inverseLerp(before.time, after.time, timestamp)
      this.mostRecentValue = this.lerpSnapshots(before, after, t)
    } else {
      // We have to extrapolate
      if (this.allowExtrapolation && beforeInd > 0) {
        after = before
        before = this.snapshots[beforeInd - 1]
        const extrapolateT = inverseLerp(before.time, after.time, timestamp)
        this.mostRecentValue = this.lerpSnapshots(before, after, extrapolateT)
      }
      this.mostRecentValue = before.value
    }

    return this.mostRecentValue
  }

  /**
   * @param a - Snapshot to interpolate from
   * @param b - Snapshot to interpolate to
   * @param t - Time delta
   * @returns Interpolated value
   */
  private lerpSnapshots(a: SyncSnapshot<StorageTypeToPrimitive[TStorageType]>, b: SyncSnapshot<StorageTypeToPrimitive[TStorageType]>, t: number): StorageTypeToPrimitive[TStorageType] {
    if (!this.lerpFunc) {
      this.log.e("Missing lerp func")
      return b.value
    }
    if (this.isArrayStorageValue(a.value)) {
      const arrayValue = a.value
      if (!this._lerpBuffer || this._lerpBuffer.length !== arrayValue.length) {
        this._lerpBuffer = new Array(arrayValue.length)
      }
      for (let i = 0; i < arrayValue.length; i++) {
        // override the lerp function return type to the non-array subset of values for the given storage type.
        this._lerpBuffer[i] = this.lerpFunc(a.value[i] as StorageTypeToPrimitive[TStorageType], b.value[i] as StorageTypeToPrimitive[TStorageType], t) as ArrayStorageTypePrimitive<TStorageType>[number]
      }
      return this._lerpBuffer
    } else {
      // we check above if this is an array, so we can safely inform the type checker that this is a non-array subset of values
      return this.lerpFunc(a.value as NonArrayStorageTypePrimitive<TStorageType>, b.value as NonArrayStorageTypePrimitive<TStorageType>, t)
    }
  }

  private isArrayStorageValue(storageValue: ArrayStorageTypePrimitive | NonArrayStorageTypePrimitive): storageValue is ArrayStorageTypePrimitive {
    return this._isArrayType
  }
}

/**
 * @param min - Min value
 * @param max - Max value
 * @param value - Value to interpolate
 * @returns Interpolated value
 */
function inverseLerp(min: number, max: number, value: number) {
  return (value - min) / (max - min)
}
