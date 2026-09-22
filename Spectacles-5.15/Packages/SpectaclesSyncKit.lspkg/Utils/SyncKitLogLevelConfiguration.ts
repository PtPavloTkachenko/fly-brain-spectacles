import {LogLevelConfiguration} from "SpectaclesInteractionKit.lspkg/Core/LogLevelConfiguration/LogLevelConfiguration"
import SyncKitLogLevelProvider from "./SyncKitLogLevelProvider"

/**
 * Allows the user to select the log level filter for Spectacles Sync Kit types from a lens studio component.
 */
@component
export class SyncKitLogLevelConfiguration extends LogLevelConfiguration {
  private SyncKitLogLevelProvider = SyncKitLogLevelProvider.getInstance()

  constructor() {
    super()

    this.SyncKitLogLevelProvider.logLevel = this.logLevelFilter
  }
}
