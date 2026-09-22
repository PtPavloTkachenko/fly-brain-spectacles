import {StorageProperty} from "../../Core/StorageProperty"
import {StoragePropertySet} from "../../Core/StoragePropertySet"
import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"
import {setTimeout} from "../../Utils/Timers"

// 10 seconds in milliseconds
const TEN_SECONDS_MS = 10000

@component
export class ManualStoragePropertyExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    ManualStoragePropertyExample.name
  )

  private myPropInt = StorageProperty.manualInt("myPropInt", 0)
  private myPropIntArray = StorageProperty.manualIntArray("myPropIntArray", [0])

  private myPropString = StorageProperty.manualString(
    "myPropString",
    "Hello, World!"
  )
  private myPropStringArray = StorageProperty.manualStringArray(
    "myPropStringArray",
    ["Hello, World!"]
  )

  private myPropBool = StorageProperty.manualBool("myPropBool", true)
  private myPropBoolArray = StorageProperty.manualBoolArray("myPropBoolArray", [
    true,
  ])

  private myPropFloat = StorageProperty.manualFloat("myPropFloat", Math.PI)
  private myPropFloatArray = StorageProperty.manualFloatArray(
    "myPropFloatArray",
    [Math.PI]
  )

  private myPropDouble = StorageProperty.manualDouble("myPropDouble", Math.PI)
  private myPropDoubleArray = StorageProperty.manualDoubleArray(
    "myPropDoubleArray",
    [Math.PI]
  )

  private myPropVec2 = StorageProperty.manualVec2("myPropVec2", vec2.zero())
  private myPropVec2Array = StorageProperty.manualVec2Array("myPropVec2Array", [
    vec2.zero(),
  ])

  private myPropVec3 = StorageProperty.manualVec3("myPropVec3", vec3.zero())
  private myPropVec3Array = StorageProperty.manualVec3Array("myPropVec3Array", [
    vec3.zero(),
  ])

  private myPropVec4 = StorageProperty.manualVec4("myPropVec4", vec4.zero())
  private myPropVec4Array = StorageProperty.manualVec4Array("myPropVec4Array", [
    vec4.zero(),
  ])

  private myPropQuat = StorageProperty.manualQuat(
    "myPropQuat",
    quat.quatIdentity()
  )
  private myPropQuatArray = StorageProperty.manualQuatArray("myPropQuatArray", [
    quat.quatIdentity(),
  ])

  private myPropMat2 = StorageProperty.manualMat2("myPropMat2", mat2.zero())
  private myPropMat2Array = StorageProperty.manualMat2Array("myPropMat2Array", [
    mat2.zero(),
  ])

  private myPropMat3 = StorageProperty.manualMat3("myPropMat3", mat3.zero())
  private myPropMat3Array = StorageProperty.manualMat3Array("myPropMat3Array", [
    mat3.zero(),
  ])

  private myPropMat4 = StorageProperty.manualMat4("myPropMat4", mat4.zero())
  private myPropMat4Array = StorageProperty.manualMat4Array("myPropMat4Array", [
    mat4.zero(),
  ])

  private myStoragePropertySet = new StoragePropertySet([
    this.myPropInt,
    this.myPropIntArray,
    this.myPropString,
    this.myPropStringArray,
    this.myPropBool,
    this.myPropBoolArray,
    this.myPropFloat,
    this.myPropFloatArray,
    this.myPropDouble,
    this.myPropDoubleArray,
    this.myPropVec2,
    this.myPropVec2Array,
    this.myPropVec3,
    this.myPropVec3Array,
    this.myPropVec4,
    this.myPropVec4Array,
    this.myPropQuat,
    this.myPropQuatArray,
    this.myPropMat2,
    this.myPropMat2Array,
    this.myPropMat3,
    this.myPropMat3Array,
    this.myPropMat4,
    this.myPropMat4Array,
  ])

  private syncEntity: SyncEntity = new SyncEntity(
    this,
    this.myStoragePropertySet,
    true
  )

  onAwake(): void {
    Object.values(this.myStoragePropertySet.storageProperties).forEach(
      (property) => {
        // Can subscribe to changes at any time
        property.onAnyChange.add((newValue, oldValue) =>
          this.onMyPropChanged(newValue, oldValue)
        )
      }
    )

    this.syncEntity.notifyOnReady(() => this.onReady())
  }

  private onReady(): void {
    Object.values(this.myStoragePropertySet.storageProperties).forEach(
      (property) => {
        // Wait until onReady before printing values
        this.log.i(
          `My property ${property.key} value starts as ${property.currentOrPendingValue}`
        )
      }
    )

    // After some time, change the value of the properties once to demonstrate how changing them works
    setTimeout(
      this,
      () => {
        if (!this.syncEntity.doIOwnStore()) {
          this.log.i("Not the syncEntity owner, not changing properties.")
          return
        }

        this.myPropInt.setPendingValue(1)
        this.myPropIntArray.setPendingValue([1, 2])
        this.myPropString.setPendingValue("Goodbye, World!")
        this.myPropStringArray.setPendingValue(["Goodbye, World!"])
        this.myPropBool.setPendingValue(false)
        this.myPropBoolArray.setPendingValue([false])
        this.myPropFloat.setPendingValue(Math.E)
        this.myPropFloatArray.setPendingValue([Math.E])
        this.myPropDouble.setPendingValue(Math.E)
        this.myPropDoubleArray.setPendingValue([Math.E])
        this.myPropVec2.setPendingValue(new vec2(1, 2))
        this.myPropVec2Array.setPendingValue([new vec2(1, 2), new vec2(3, 4)])
        this.myPropVec3.setPendingValue(new vec3(1, 2, 3))
        this.myPropVec3Array.setPendingValue([
          new vec3(1, 2, 3),
          new vec3(4, 5, 6),
        ])
        this.myPropVec4.setPendingValue(new vec4(1, 2, 3, 4))
        this.myPropVec4Array.setPendingValue([
          new vec4(1, 2, 3, 4),
          new vec4(5, 6, 7, 8),
        ])
        this.myPropQuat.setPendingValue(quat.fromEulerVec(new vec3(0, 0, 1)))
        this.myPropQuatArray.setPendingValue([
          quat.fromEulerVec(new vec3(0, 0, 1)),
          quat.fromEulerVec(new vec3(0, 1, 0)),
        ])
        this.myPropMat2.setPendingValue(mat2.identity())
        this.myPropMat2Array.setPendingValue([mat2.identity(), mat2.identity()])
        this.myPropMat3.setPendingValue(mat3.identity())
        this.myPropMat3Array.setPendingValue([mat3.identity(), mat3.identity()])
        this.myPropMat4.setPendingValue(mat4.identity())
        this.myPropMat4Array.setPendingValue([mat4.identity(), mat4.identity()])
      },
      TEN_SECONDS_MS
    )
  }

  private onMyPropChanged<T>(newValue: T, oldValue: T): void {
    this.log.i(`My property changed from ${oldValue} to ${newValue}`)
  }
}
