import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {VersionNumber} from "../VersionNumber"
import {SessionController} from "./SessionController"

const TAG = "SessionControllerComponent"

export enum StartMode {
  Menu = "START_MENU",
  Multiplayer = "MULTIPLAYER",
  Off = "OFF"
}

@component
export class SessionControllerComponent extends BaseScriptComponent {
  private log = new SyncKitLogger(TAG)

  @input
  private readonly connectedLensModule: ConnectedLensModule

  @input
  private readonly locationCloudStorageModule: LocationCloudStorageModule

  @input("boolean", "true")
  private readonly isColocated: boolean = false

  @ui.group_start("Colocation")
  @showIf("isColocated")
  @input
  private readonly locatedAtComponent: LocatedAtComponent

  @ui.group_end
  @ui.group_start("Start Mode Configuration")
  @input("string", "START_MENU")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Start Menu", "START_MENU"),
      new ComboBoxItem("Multiplayer", "MULTIPLAYER"),
      new ComboBoxItem("Off", "OFF")
    ])
  )
  private readonly startMode: StartMode = StartMode.Menu

  @ui.group_end
  @ui.group_start("Location Based Experiences")
  @input("boolean", "true")
  private readonly skipCustomLandmarkInLensStudio: boolean = true

  @ui.group_end
  private onAwake(): void {
    this.log.i(`Using Spectacles Sync Kit version ${VersionNumber}`)

    SessionController.getInstance().configure(
      this,
      this.connectedLensModule,
      this.locationCloudStorageModule,
      this.isColocated,
      this.locatedAtComponent,
      this.startMode,
      this.skipCustomLandmarkInLensStudio
    )
  }

  public getStartMode(): StartMode {
    return this.startMode
  }
}
