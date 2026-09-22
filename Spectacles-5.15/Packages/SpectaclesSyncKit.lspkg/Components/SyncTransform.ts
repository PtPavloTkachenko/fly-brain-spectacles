import {NetworkIdOptions} from "../Core/NetworkIdTools"
import {networkIdFromString, NetworkIdType} from "../Core/NetworkIdType"
import {persistenceTypeFromString} from "../Core/PersistenceType"
import {PropertyType, propertyTypeFromString} from "../Core/PropertyType"
import {StorageProperty} from "../Core/StorageProperty"
import {StoragePropertySet} from "../Core/StoragePropertySet"
import {SyncEntity} from "../Core/SyncEntity"

/**
 * Add this to any SceneObject to automatically synchronize its position, rotation, and/or scale,
 * depending on the settings chosen in the Inspector panel.
 */
@component
export class SyncTransform extends BaseScriptComponent {
  @input("string", "objectId")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Object Id", "objectId"),
      new ComboBoxItem("Custom", "custom"),
    ])
  )
  @label("Network Id Type")
  private readonly networkIdTypeString: string = "objectId"
  private readonly networkIdType: NetworkIdType = networkIdFromString(
    this.networkIdTypeString
  )

  @input("string", "enter_unique_id")
  @showIf("networkIdTypeString", "custom")
  private readonly customNetworkId: string = "enter_unique_id"

  @ui.separator
  @ui.label("Sync Settings")
  @input("string", "Location")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "None"),
      new ComboBoxItem("Location", "Location"),
      new ComboBoxItem("Local", "Local"),
      new ComboBoxItem("World", "World"),
    ])
  )
  @label("Position Sync")
  private readonly positionSyncString: string = "Location"
  private readonly positionSync: PropertyType = propertyTypeFromString(
    this.positionSyncString
  )

  @input("string", "Location")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "None"),
      new ComboBoxItem("Location", "Location"),
      new ComboBoxItem("Local", "Local"),
      new ComboBoxItem("World", "World"),
    ])
  )
  @label("Rotation Sync")
  private readonly rotationSyncString: string = "Location"
  private readonly rotationSync: PropertyType = propertyTypeFromString(
    this.rotationSyncString
  )

  @input("string", "Location")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "None"),
      new ComboBoxItem("Location", "Location"),
      new ComboBoxItem("Local", "Local"),
      new ComboBoxItem("World", "World"),
    ])
  )
  @label("Scale Sync")
  private readonly scaleSyncString: string = "Location"
  private readonly scaleSync: PropertyType = propertyTypeFromString(
    this.scaleSyncString
  )

  @ui.separator
  @input("string", "Session")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Ephemeral", "Ephemeral"),
      new ComboBoxItem("Owner", "Owner"),
      new ComboBoxItem("Session", "Session"),
      new ComboBoxItem("Persist", "Persist"),
    ])
  )
  @label("Persistence")
  private readonly persistenceString: string = "Session"
  private readonly persistence: RealtimeStoreCreateOptions.Persistence =
    persistenceTypeFromString(this.persistenceString)

  @input("int", "10")
  private readonly sendsPerSecondLimit: number = 10

  @input("boolean", "false")
  private readonly useSmoothing: boolean = false

  @input("float", "-0.25")
  @showIf("useSmoothing", true)
  private readonly interpolationTarget: number = -0.25

  private readonly currentTransform = this.getTransform()

  private readonly transformProp = StorageProperty.forTransform(
    this.currentTransform,
    this.positionSync,
    this.rotationSync,
    this.scaleSync,
    this.useSmoothing ? {interpolationTarget: this.interpolationTarget} : null
  )

  private readonly storageProps = new StoragePropertySet([this.transformProp])

  public readonly syncEntity = new SyncEntity(
    this,
    this.storageProps,
    false,
    this.persistence,
    new NetworkIdOptions(this.networkIdType, this.customNetworkId)
  )

  constructor() {
    super()
    this.transformProp.sendsPerSecondLimit = this.sendsPerSecondLimit
  }
}
