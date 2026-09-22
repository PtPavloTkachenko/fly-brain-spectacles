import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import SyncKitLogLevelProvider from "./SyncKitLogLevelProvider"

/**
 * Logger for Spectacles Sync Kit.
 */
export class SyncKitLogger extends NativeLogger {
  constructor(tag: string) {
    super(tag, SyncKitLogLevelProvider.getInstance())
  }
}
