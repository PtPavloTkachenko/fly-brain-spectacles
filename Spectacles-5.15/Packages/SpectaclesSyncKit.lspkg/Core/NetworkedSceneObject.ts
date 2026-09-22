import {NetworkRootInfo} from "./NetworkRootInfo"

/**
 * Additional networking information stored on networked scene objects.
 */
export type NetworkedSceneObject = SceneObject & {
  _networkRoot: NetworkRootInfo
  _isNetworkRoot: boolean
}
