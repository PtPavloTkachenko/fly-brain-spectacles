import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"

const TAG = "DisplayStorageProperty"
/**
 * Displays a Storage Property value found on the specified Entity Target.
 * The Property Key should match the one being used by the storage property.
 */
@component
export class DisplayStorageProperty extends BaseScriptComponent {
  @ui.group_start("Entity Target")
  @input
  private readonly syncEntityScript: ScriptComponent

  @ui.group_end
  @input("string")
  private readonly propertyKey: string

  @input
  private readonly text: Text

  @input("boolean", "false")
  private readonly useFormat: boolean

  @ui.label(
    "String will be formatted using:<br>{value} - current value (or blank)<br>{prevValue} - previous value (or blank)",
  )
  @showIf("useFormat")
  @input("string")
  private readonly formatString: string

  @ui.label("Text to display if value is undefined")
  @input("string")
  private readonly altText: string

  private log = new SyncKitLogger(TAG)

  private syncEntity: SyncEntity

  private onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.init())
  }

  private updateValue(newValue: unknown, oldValue?: unknown) {
    let newText = ""
    if (newValue === undefined) {
      newText = this.altText
    } else if (this.useFormat) {
      newText = this.formatString
        .replace("{value}", String(newValue))
        .replace("{prevValue}", String(oldValue))
    } else {
      newText = String(newValue)
    }
    this.text.text = newText
  }

  private init() {
    this.updateValue(undefined)
    this.syncEntity = SyncEntity.getSyncEntityOnComponent(this.syncEntityScript)
    if (!this.syncEntity) {
      this.log.e("Could not find syncEntity!")
    } else {
      this.syncEntity.notifyOnReady(() => this.getProperty())
    }
  }

  private getProperty() {
    const property = this.syncEntity.propertySet.getProperty(this.propertyKey)
    if (property) {
      this.updateValue(property.currentValue, null)
      property.onAnyChange.add((newValue, oldValue) =>
        this.updateValue(newValue, oldValue),
      )
    } else {
      this.log.e("Couldn't find property with key: " + this.propertyKey)
    }
  }
}
