import {NetworkIdOptions} from "../Core/NetworkIdTools"
import {networkIdFromString, NetworkIdType} from "../Core/NetworkIdType"
import {StorageProperty} from "../Core/StorageProperty"
import {StoragePropertySet} from "../Core/StoragePropertySet"
import {StorageTypes} from "../Core/StorageTypes"
import {SyncEntity} from "../Core/SyncEntity"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

const TAG = "SyncMaterials"
/**
 * Synchronizes material properties across the network.
 * Add this to a SceneObject and assign the material you want synchronized in Main Material.
 * Add each property name you want synchronized to the Property Names list.
 * Any changes to these properties will be automatically synchronized across the network.
 */
@component
export class SyncMaterials extends BaseScriptComponent {
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
  @input("boolean", "true")
  private readonly autoClone: boolean = true

  @input
  private readonly mainMaterial: Material

  @input
  private readonly propertyNames: string[]

  private log = new SyncKitLogger(TAG)

  private newMat: Material

  private readonly storageProps = new StoragePropertySet()

  public readonly syncEntity = new SyncEntity(
    this,
    this.storageProps,
    null,
    null,
    new NetworkIdOptions(this.networkIdType, this.customNetworkId)
  )

  private onAwake(): void {
    if (!this.mainMaterial) {
      this.log.e("You need to set mainMaterial!")
      return
    }

    if (this.autoClone) {
      this.newMat = this.mainMaterial.clone()
      const visuals = this.getComponentsRecursive<MaterialMeshVisual>(
        this.getSceneObject(),
        "MaterialMeshVisual"
      )
      for (let i = 0; i < visuals.length; i++) {
        const materials = visuals[i].materials
        let needsToUpdateMaterials = false
        for (let j = 0; j < materials.length; j++) {
          // If a material matches the one we cloned, we need to replace it with the new, cloned material
          if (this.mainMaterial.isSame(materials[j])) {
            materials[j] = this.newMat
            needsToUpdateMaterials = true
          }
        }
        // Our material list was provided as a copy, so if any materials were changed, we need to overwrite the visual's material list using our new version
        if (needsToUpdateMaterials) {
          visuals[i].materials = materials
        }
      }
    } else {
      this.newMat = this.mainMaterial
    }

    const mainPass = this.newMat.mainPass
    for (let i = 0; i < this.propertyNames.length; i++) {
      const propName = this.propertyNames[i]
      const propVal = mainPass[propName]
      const type = this.deduceStorageType(propVal)
      const newProp = StorageProperty.forMaterialProperty(
        this.newMat,
        propName,
        type
      )
      this.storageProps.addProperty(newProp)
    }
  }

  private deduceStorageType(propValue: number | any): StorageTypes {
    switch (typeof propValue) {
      case "number":
        return StorageTypes.float
      case "boolean":
        return StorageTypes.bool
      case "string":
        return StorageTypes.string
      case "object":
        if (propValue instanceof vec2) {
          return StorageTypes.vec2
        } else if (propValue instanceof vec3) {
          return StorageTypes.vec3
        } else if (propValue instanceof vec4) {
          return StorageTypes.vec4
        } else if (propValue instanceof quat) {
          return StorageTypes.quat
        } else if (propValue instanceof mat2) {
          return StorageTypes.mat2
        } else if (propValue instanceof mat3) {
          return StorageTypes.mat3
        } else if (propValue instanceof mat4) {
          return StorageTypes.mat4
        }
    }
  }

  /**
   * Returns a list of all Components of `componentType` found in the object and its descendents.
   * @param object - Object to search
   * @param componentType - Component type name to search for
   * @param results - Optional list to store results in
   * @returns An array of matching Components in `object` and descendants
   */
  private getComponentsRecursive<T extends Component>(
    object: SceneObject,
    componentType: keyof ComponentNameMap,
    results?: T[]
  ): T[] {
    results = results || []
    const components = object.getComponents(componentType) as T[]
    for (let i = 0; i < components.length; i++) {
      results.push(components[i])
    }
    const childCount = object.getChildrenCount()
    for (let j = 0; j < childCount; j++) {
      this.getComponentsRecursive(object.getChild(j), componentType, results)
    }
    return results
  }
}
