import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {NetworkedSceneObject} from "./NetworkedSceneObject"
import {NetworkMessageWrapper} from "./NetworkMessageWrapper"
import {NetworkRootInfo} from "./NetworkRootInfo"
import {StoreEventWrapper} from "./StoreEventWrapper"

export const NETWORK_ID_KEY = "_network_id"
export const NETWORK_TYPE_KEY = "_network_type"

export type NetworkIdFilter = (store: GeneralDataStore) => boolean

const TAG = "NetworkUtils"
const log = new SyncKitLogger(TAG)

/**
 * Returns `true` if the passed in `sceneObject` has a `NetworkRootInfo` attached to it.
 * @param sceneObject - The scene object to check.
 * @returns `true` if the scene object has a `NetworkRootInfo` attached, otherwise `false`.
 */
export function isRootObject(sceneObject: SceneObject): boolean {
  const networkedSceneObject = sceneObject as NetworkedSceneObject
  if (networkedSceneObject._isNetworkRoot) {
    return true
  }
  return false
}

/**
 * Recursively searches upwards in the hierarchy to find a `NetworkRootInfo` object.
 * @param sceneObject - The scene object to start the search from.
 * @returns The `NetworkRootInfo` object if found, otherwise `null`.
 */
export function findNetworkRoot(
  sceneObject: SceneObject,
): NetworkRootInfo | null {
  const networkedSceneObject = sceneObject as NetworkedSceneObject
  if (isRootObject(sceneObject)) {
    return networkedSceneObject._networkRoot
  }
  if (sceneObject.hasParent()) {
    return findNetworkRoot(sceneObject.getParent())
  }
  return null
}

export function isTransform(
  target: Transform | SceneObject | Component,
): target is Transform {
  return target.isOfType("Transform")
}

export function isSceneObject(
  target: Transform | SceneObject | Component,
): target is SceneObject {
  return target.isOfType("SceneObject")
}

/**
 * Gets the scene object from the target.
 * @param target - The target to get the scene object from.
 * @returns The scene object if found, otherwise `null`.
 */
export function getSceneObjectHelper(
  target: Transform | SceneObject | Component,
): SceneObject | null {
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
 * Gets the network id from the data store.
 * @param store - The data store to get the network id from.
 * @returns The network id.
 */
export function getNetworkIdFromStore(store: GeneralDataStore): string {
  return store.getString(NETWORK_ID_KEY)
}

/**
 * Writes the id to the data store.
 * @param store - The data store to write the id to.
 * @param id - The id to write.
 */
export function putNetworkIdToStore(store: GeneralDataStore, id: string) {
  store.putString(NETWORK_ID_KEY, id)
}

/**
 * Gets the network type from the data store.
 * @param store - The data store to get the network type from.
 * @returns The network type.
 */
export function getNetworkTypeFromStore(store: GeneralDataStore): string {
  return store.getString(NETWORK_TYPE_KEY)
}

/**
 * Writes the network type to the data store.
 * @param store - The data store to write the network type to.
 * @param type - The network type to write.
 */
export function putNetworkTypeToStore(store: GeneralDataStore, type: string) {
  store.putString(NETWORK_TYPE_KEY, type)
}

/**
 * Helper function to convert from string, or null, to {@link RealtimeStoreCreateOptions.Persistence}.
 * @param persistence - The persistence value to convert.
 * @returns The converted persistence value.
 */
export function getPersistenceFromValue(
  persistence?:
    | keyof typeof RealtimeStoreCreateOptions.Persistence
    | RealtimeStoreCreateOptions.Persistence
    | null,
): RealtimeStoreCreateOptions.Persistence {
  if (persistence === null || persistence === undefined) {
    return RealtimeStoreCreateOptions.Persistence.Session
  }
  if (typeof persistence === "string") {
    if (persistence in RealtimeStoreCreateOptions.Persistence) {
      persistence = RealtimeStoreCreateOptions.Persistence[persistence]
    } else {
      log.w("Invalid persistence type: " + persistence)
      return RealtimeStoreCreateOptions.Persistence.Session
    }
  }
  return persistence
}

/**
 * Stringifies an object to JSON.
 * @param obj - The object to stringify.
 * @returns The JSON string.
 */
export function lsJSONStringify(obj: unknown): string {
  return JSON.stringify(obj, lsJSONReplacer)
}

/**
 * Parses a JSON string.
 * @param text - The JSON string to parse.
 * @returns The parsed object.
 */
export function lsJSONParse(text: string): unknown {
  return JSON.parse(text, lsJSONReviver)
}

// JSON Serialization Helpers

const LS_TYPE_KEY = "___lst"

/**
 * Configuration for JSON data serialization.
 */
export class LSJSONDataConfig<T, U extends unknown[]> {
  constructor(
    public constructorFunc: new (...args: U) => T,
    public props: (keyof T)[],
  ) {}

  /**
   * Gets the constructor arguments from the object.
   * @param obj - The object to get the arguments from.
   * @returns The constructor arguments.
   */
  getArgs(obj: T): unknown[] {
    const argumentArray = new Array(this.props.length)
    for (let i = 0; i < this.props.length; i++) {
      argumentArray[i] = obj[this.props[i]]
    }
    return argumentArray
  }

  /**
   * Constructs an object from the arguments.
   * @param args - The constructor arguments.
   * @returns The constructed object.
   */
  construct(args: U): T {
    return new this.constructorFunc(...args)
  }
}

const _lsJSONConfigLookup = {
  vec2: new LSJSONDataConfig<vec2, unknown[]>(vec2, ["x", "y"]),
  vec3: new LSJSONDataConfig<vec3, unknown[]>(vec3, ["x", "y", "z"]),
  vec4: new LSJSONDataConfig<vec4, unknown[]>(vec4, ["x", "y", "z", "w"]),
  quat: new LSJSONDataConfig<quat, unknown[]>(quat, ["w", "x", "y", "z"]),
}

/**
 * JSON replacer function for serialization.
 * @param _key - The key being replaced.
 * @param value - The value being replaced.
 * @returns The replaced value.
 */
function lsJSONReplacer(_key: string, value: unknown) {
  if (typeof value === "object") {
    for (const configKey in _lsJSONConfigLookup) {
      const config = _lsJSONConfigLookup[configKey]
      if (value instanceof config.constructorFunc) {
        const data: {[key: string]: unknown} = {}
        data[LS_TYPE_KEY] = configKey
        data.a = config.getArgs(value)
        return data
      }
    }
  }
  return value
}

/**
 * JSON reviver function for deserialization.
 * @param _key - The key being revived.
 * @param value - The value being revived.
 * @returns The revived value.
 */
function lsJSONReviver(_key: string, value: unknown & {a: unknown}) {
  if (typeof value === "object") {
    const typeKey = value[LS_TYPE_KEY]
    if (typeKey !== undefined) {
      const config = _lsJSONConfigLookup[typeKey]
      if (config) {
        return config.construct(value.a)
      }
    }
  }
  return value
}

export const NetworkUtils = {
  NetworkRootInfo: NetworkRootInfo,
  StoreEventWrapper: StoreEventWrapper,
  NetworkMessageWrapper: NetworkMessageWrapper,
  isRootObject: isRootObject,
  findNetworkRoot: findNetworkRoot,
  getNetworkIdFromStore: getNetworkIdFromStore,
  putNetworkIdToStore: putNetworkIdToStore,
  getNetworkTypeFromStore: getNetworkTypeFromStore,
  putNetworkTypeToStore: putNetworkTypeToStore,
  getPersistenceFromValue: getPersistenceFromValue,
  lsJSONParse: lsJSONParse,
  lsJSONStringify: lsJSONStringify,
}

// These exports exist for javascript compatibility, and should not be used from typescript code.
;(global as any).networkUtils = NetworkUtils
;(global as any).NETWORK_ID_KEY = NETWORK_ID_KEY
;(global as any).NETWORK_TYPE_KEY = NETWORK_TYPE_KEY
