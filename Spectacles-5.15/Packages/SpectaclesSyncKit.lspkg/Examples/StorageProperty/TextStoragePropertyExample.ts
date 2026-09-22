import {StorageProperty} from "../../Core/StorageProperty"
import {StoragePropertySet} from "../../Core/StoragePropertySet"
import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"

// The text to scroll
const SCROLLING_TEXT = "Hello, World!"

@component
export class TextStoragePropertyExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    TextStoragePropertyExample.name
  )

  @input
  myText: Text = null

  private myPropText = StorageProperty.forTextText(this.myText)

  private myStoragePropertySet = new StoragePropertySet([this.myPropText])

  private syncEntity: SyncEntity = new SyncEntity(
    this,
    this.myStoragePropertySet,
    true
  )

  onAwake(): void {
    this.createEvent("UpdateEvent").bind(() => this.updateText())
  }

  private updateText(): void {
    if (!this.syncEntity.doIOwnStore()) {
      this.log.i("Not the syncEntity owner, not changing anything.")
      return
    }

    const numChars = getTime() % SCROLLING_TEXT.length
    const newText = SCROLLING_TEXT.substring(0, numChars)
    this.myText.text = newText
  }
}
