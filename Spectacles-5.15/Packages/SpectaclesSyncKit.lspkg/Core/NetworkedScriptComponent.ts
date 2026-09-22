import {NetworkIdType} from "./NetworkIdType"
import {SyncEntity} from "./SyncEntity"

/**
 * @deprecated
 * This type represents additional data stored on a script component about how
 * it should be networked.
 */
export type NetworkedScriptComponent = ScriptComponent & {
  _syncEntity: SyncEntity
  networkIdType: NetworkIdType
  customNetworkId: string
}
