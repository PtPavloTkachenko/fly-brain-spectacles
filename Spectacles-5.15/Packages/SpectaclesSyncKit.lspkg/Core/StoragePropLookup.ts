import {KeyedEventWrapper} from "./KeyedEventWrapper"
import {StorageProperty} from "./StorageProperty"
import { StorageTypes, StorageTypeToPrimitive } from "./StorageTypes"
import {SyncEntity} from "./SyncEntity"

export class StoragePropLookup<TStorageType extends StorageTypes> {
  propertyDic: Map<string, StorageProperty<TStorageType>> = new Map()

  onChange: KeyedEventWrapper<[StorageTypeToPrimitive[TStorageType], StorageTypeToPrimitive[TStorageType]]> = new KeyedEventWrapper()

  onAnyChange: KeyedEventWrapper<[string, StorageTypeToPrimitive[TStorageType], StorageTypeToPrimitive[TStorageType]]> = new KeyedEventWrapper()

  /**
   * @param SyncEntity - syncEntity
   * @param string - prefix
   * @param StorageType - storageType
   */
  constructor(
    private _syncEntity: SyncEntity,
    private prefix: string = "",
    private _storageType: TStorageType
  ) {
    this._syncEntity.storeCallbacks.onStoreUpdated.add((session, store, key) =>
      this._onStoreUpdated(session, store, key)
    )

    this._syncEntity.notifyOnReady(() => this._populateFromCurrentStore())
  }

  private _onStoreUpdated(
    _session: MultiplayerSession,
    _store: GeneralDataStore,
    key: string
  ): void {
    this._checkAddStoreValue(key)
  }

  /**
   * @param key - The key to add
   * @param startValue - The initial value to apply
   * @returns The property that was added
   */
  addProperty(key: string, startValue?: StorageTypeToPrimitive[TStorageType]): StorageProperty<TStorageType> {
    const newKey = this.prefix + key
    const existingProp = this._syncEntity.propertySet.getProperty<TStorageType>(newKey)
    if (existingProp) {
      this.propertyDic[key] = existingProp
      return existingProp
    } else {
      const prop = StorageProperty.manual(newKey, this._storageType, startValue)
      this._syncEntity.addStorageProperty(prop)
      this.propertyDic[key] = prop
      prop.onAnyChange.add((newValue, prevValue) => {
        this.onChange.trigger(key, newValue, prevValue)
      })
      this.onChange.trigger(key, prop.currentValue, undefined)
      return prop
    }
  }

  private _populateFromCurrentStore(): void {
    // Get all existing keys in store
    const allKeys = this._syncEntity.currentStore.getAllKeys()

    // Set up props based on existing store values
    for (let i = 0; i < allKeys.length; i++) {
      this._checkAddStoreValue(allKeys[i])
    }
  }

  /**
   * @param key - The key to check
   * @returns The property that was added, or null if no property was added
   */
  private _checkAddStoreValue(key: string): StorageProperty<TStorageType> | null {
    if (key.startsWith(this.prefix)) {
      const id = this._getStorageKeyForKey(key)
      return this.addProperty(id)
    }
  }

  /**
   * @param key - The key to get
   * @returns The property with the given key, or null if no property exists with that key
   */
  getProperty(key: string): StorageProperty<TStorageType> | null {
    return this.propertyDic[key]
  }

  /**
   * @param key - The key to remove
   * @returns Key used internally for storing the property
   */
  private _getStorageKeyForKey(key: string): string {
    return this.removeFromStart(key, this.prefix)
  }

  /**
   * @param text - The text to remove from
   * @param prefix - The prefix to remove
   * @returns - The text with the prefix removed
   */
  removeFromStart(text: string, prefix: string): string {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length)
    }
    return text
  }
}

// These exports exist for javascript compatibility, and should not be used from typescript code.
;(global as any).StoragePropLookup = StoragePropLookup
