import {NetworkRootInfo} from "../../Core/NetworkRootInfo"
import {findNetworkRoot, NETWORK_ID_KEY, NETWORK_TYPE_KEY} from "../../Core/NetworkUtils"
import {SessionController} from "../../Core/SessionController"
import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"
import { CapsuleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/CapsuleButton"

/**
 * Used to display helpful debugging information about a SyncEntity.
 */
@component
export class SyncEntityDebug extends BaseScriptComponent {
  @ui.group_start("Entity Target")
  @input("string", "SyncEntity")
  @widget(
    new ComboBoxWidget([new ComboBoxItem("Sync Entity", "SyncEntity"), new ComboBoxItem("Network Root", "NetworkRoot")])
  )
  @label("Target Type")
  private readonly targetTypeString: "SyncEntity" | "NetworkRoot" = "SyncEntity"

  @input
  @showIf("targetTypeString", "SyncEntity")
  syncEntityScript: ScriptComponent

  @ui.group_end
  @ui.group_start("Text Labels")
  @allowUndefined
  @input
  networkIdText?: Text

  @ui.label("Owner Info")
  @allowUndefined
  @input
  ownerDisplayNameText?: Text

  @allowUndefined
  @input
  ownershipButton?: CapsuleButton

  @allowUndefined
  @input
  ownershipButtonText?: Text

  @allowUndefined
  @input
  ownerIdText?: Text

  @ui.label("Store Info")
  @allowUndefined
  @input
  storagePropertyText?: Text

  @ui.group_end
  private log = new SyncKitLogger(SyncEntityDebug.name)

  private syncEntity: SyncEntity | null

  private networkRoot: NetworkRootInfo | null

  private onAwake(): void {
    // We use OnStartEvent to ensure that the SyncEntity has been fully initialized
    this.createEvent("OnStartEvent").bind(() => this.init())
  }

  /**
   * @param textComponent - The Text component to update
   * @param text - The text to set
   */
  private textHelper(textComponent: Text, text: string) {
    if (!isNull(textComponent)) {
      textComponent.text = String(text)
    }
  }

  private updateButtonText() {
    this.textHelper(
      this.ownershipButtonText, 
      this.syncEntity.doIOwnStore() ? "Unclaim" : "Claim"
    )
  }

  /**
   * @param ownerInfo - The new owner info
   */
  private updateOwnerText(ownerInfo: ConnectedLensModule.UserInfo) {
    this.textHelper(this.ownerIdText, "id: " + ((ownerInfo && ownerInfo.connectionId) || "<unowned>"))
    this.textHelper(this.ownerDisplayNameText, (ownerInfo && ownerInfo.displayName) || "<unowned>")
  }

  /**
   * @param networkId - The new network id
   */
  private updateNetworkId(networkId: string) {
    this.textHelper(this.networkIdText, "id: " + networkId)
  }

  /**
   * @param object - The object to get the hierarchy path for
   * @returns The hierarchy path
   */
  private getHierarchyPath(object: SceneObject): string {
    const path = object.name
    if (object.hasParent()) {
      return this.getHierarchyPath(object.getParent()) + "/" + path
    }
    return path
  }

  /**
   * @param lastKeyChanged - The last key changed
   */
  private updateStorageText(lastKeyChanged?: string) {
    if (!this.storagePropertyText) {
      return
    }

    let txt = ""

    if (this.syncEntity && !this.syncEntity.destroyed && !isNull(this.syncEntity.localScript)) {
      txt += this.getHierarchyPath(this.syncEntity.localScript.getSceneObject()) + "\n"
    }

    txt += "----Storage----\n"

    const propertySet = this.syncEntity.propertySet

    const allValues = {}

    const pendingValues = {}

    const currentOrPendingValues = {}

    if (this.syncEntity.currentStore) {
      const allKeys = this.syncEntity.currentStore.getAllKeys()
      for (let i = 0; i < allKeys.length; i++) {
        const key = allKeys[i]

        if (key === NETWORK_ID_KEY) {
          continue
          // allValues[key] = syncEntity.currentStore.getString(key);
        }

        if (key === NETWORK_TYPE_KEY) {
          allValues[key] = this.syncEntity.currentStore.getString(key)
        }

        allValues[key] = null
      }
    } else {
      txt += "[No RealtimeStore connected]\n"
    }

    if (propertySet.storageProperties) {
      const keys = Object.keys(propertySet.storageProperties)
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        const prop = propertySet.storageProperties[key]
        allValues[key] = prop.currentValue
        if (prop.pendingValue !== null && prop.pendingValue !== undefined) {
          pendingValues[key] = prop.pendingValue
        }
        if (prop.currentOrPendingValue !== null && prop.currentOrPendingValue !== undefined) {
          currentOrPendingValues[key] = prop.currentOrPendingValue
        }
      }
    }

    const keys = Object.keys(allValues)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (key === lastKeyChanged) {
        txt += "*"
      }
      const valueText = allValues[key] === null || allValues[key] === undefined ? "?" : allValues[key]
      txt += key + ": " + valueText
      if (key in pendingValues) {
        txt += "  [pen]: " + pendingValues[key]
      }
      if (key in currentOrPendingValues) {
        txt += "  [cur/pen]: " + currentOrPendingValues[key]
      }
      txt += "\n"
    }

    this.textHelper(this.storagePropertyText, txt)
  }

  private onOwnershipButtonPressed() {
    if (this.syncEntity.doIOwnStore()) {
      SessionController.getInstance()
        .getSession()
        .clearRealtimeStoreOwnership(
          this.syncEntity.currentStore,
          () => {
            this.log.i(`Ownership cleared for ${SessionController.getInstance().getLocalUserName()}`)
          },
          (error: string) => {
            this.log.e("Error clearing ownership: " + error)
          }
        )
    } else {
      SessionController.getInstance()
        .getSession()
        .requestRealtimeStoreOwnership(
          this.syncEntity.currentStore,
          () => {
            this.log.i(`Ownership gained for ${SessionController.getInstance().getLocalUserName()}`)
          },
          (error: string) => {
            this.log.e("Error requesting ownership: " + error)
          }
        )
    }
  }

  private init() {
    switch (this.targetTypeString) {
      case "SyncEntity":
        this.syncEntity = SyncEntity.getSyncEntityOnComponent(this.syncEntityScript)
        this.syncEntity.onOwnerUpdated.add((ownerInfo: ConnectedLensModule.UserInfo) => {
          this.updateOwnerText(ownerInfo)
          this.updateButtonText()
        })
        this.updateNetworkId(this.syncEntity.networkId)
        this.updateOwnerText(this.syncEntity.ownerInfo)
        this.updateStorageText(null)        
        if (this.ownershipButton) {
          this.updateButtonText();
        }

        this.syncEntity.notifyOnReady(() => {
          this.updateNetworkId(this.syncEntity.networkId)
          this.updateOwnerText(this.syncEntity.ownerInfo)
          this.updateStorageText(null)
          if (this.ownershipButton) {
            this.updateButtonText();
            this.ownershipButton.onTriggerUp.add(() => this.onOwnershipButtonPressed())
          }
        })

        this.syncEntity.storeCallbacks.onStoreUpdated.add((_session, _store, key) => {
          this.updateStorageText(key)
        })
        break
      case "NetworkRoot":
        this.networkRoot = findNetworkRoot(this.getSceneObject())
        if (this.networkRoot) {
          this.updateOwnerText(this.networkRoot.ownerInfo)
          this.updateNetworkId(this.networkRoot.networkId)
          if (this.storagePropertyText) {
            this.storagePropertyText.getSceneObject().enabled = false
          }
          if (this.ownershipButton) {
            this.ownershipButton.getSceneObject().enabled = false
          }
        }
        break
    }
  }
}
