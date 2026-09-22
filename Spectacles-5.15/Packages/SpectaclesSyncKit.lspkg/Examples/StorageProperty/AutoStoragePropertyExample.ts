import {StorageProperty} from "../../Core/StorageProperty"
import {StoragePropertySet} from "../../Core/StoragePropertySet"
import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"
import {setTimeout} from "../../Utils/Timers"

// 10 seconds in milliseconds
const TEN_SECONDS_MS = 10000

@component
export class AutoStoragePropertyExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    AutoStoragePropertyExample.name
  )

  private myInt = 0
  private myIntArray = [0]
  private myFloat = Math.PI
  private myFloatArray = [Math.PI]
  private myDouble = Math.PI
  private myDoubleArray = [Math.PI]
  private myBool = false
  private myBoolArray = [false]
  private myString = "Hello, World!"
  private myStringArray = ["Hello, World!"]
  private myVec2: vec2 = vec2.zero()
  private myVec2Array: vec2[] = [vec2.zero()]
  private myVec3: vec3 = vec3.zero()
  private myVec3Array: vec3[] = [vec3.zero()]
  private myVec4: vec4 = vec4.zero()
  private myVec4Array: vec4[] = [vec4.zero()]
  private myQuat: quat = quat.quatIdentity()
  private myQuatArray: quat[] = [quat.quatIdentity()]
  private myMat2: mat2 = mat2.zero()
  private myMat2Array: mat2[] = [mat2.zero()]
  private myMat3: mat3 = mat3.zero()
  private myMat3Array: mat3[] = [mat3.zero()]
  private myMat4: mat4 = mat4.zero()
  private myMat4Array: mat4[] = [mat4.zero()]

  private myPropInt = StorageProperty.autoInt(
    "myPropInt",
    () => this.myInt,
    (newValue) => (this.myInt = newValue)
  )
  private myPropIntArray = StorageProperty.autoIntArray(
    "myPropIntArray",
    () => this.myIntArray,
    (newValue) => (this.myIntArray = newValue)
  )

  private myPropString = StorageProperty.autoString(
    "myPropString",
    () => this.myString,
    (newValue) => (this.myString = newValue)
  )
  private myPropStringArray = StorageProperty.autoStringArray(
    "myPropStringArray",
    () => this.myStringArray,
    (newValue) => (this.myStringArray = newValue)
  )

  private myPropBool = StorageProperty.autoBool(
    "myPropBool",
    () => this.myBool,
    (newValue) => (this.myBool = newValue)
  )
  private myPropBoolArray = StorageProperty.autoBoolArray(
    "myPropBoolArray",
    () => this.myBoolArray,
    (newValue) => (this.myBoolArray = newValue)
  )

  private myPropFloat = StorageProperty.autoFloat(
    "myPropFloat",
    () => this.myFloat,
    (newValue) => (this.myFloat = newValue)
  )
  private myPropFloatArray = StorageProperty.autoFloatArray(
    "myPropFloatArray",
    () => this.myFloatArray,
    (newValue) => (this.myFloatArray = newValue)
  )

  private myPropDouble = StorageProperty.autoDouble(
    "myPropDouble",
    () => this.myDouble,
    (newValue) => (this.myDouble = newValue)
  )
  private myPropDoubleArray = StorageProperty.autoDoubleArray(
    "myPropDoubleArray",
    () => this.myDoubleArray,
    (newValue) => (this.myDoubleArray = newValue)
  )

  private myPropVec2 = StorageProperty.autoVec2(
    "myPropVec2",
    () => this.myVec2,
    (newValue) => (this.myVec2 = newValue)
  )
  private myPropVec2Array = StorageProperty.autoVec2Array(
    "myPropVec2Array",
    () => this.myVec2Array,
    (newValue) => (this.myVec2Array = newValue)
  )

  private myPropVec3 = StorageProperty.autoVec3(
    "myPropVec3",
    () => this.myVec3,
    (newValue) => (this.myVec3 = newValue)
  )
  private myPropVec3Array = StorageProperty.autoVec3Array(
    "myPropVec3Array",
    () => this.myVec3Array,
    (newValue) => (this.myVec3Array = newValue)
  )

  private myPropVec4 = StorageProperty.autoVec4(
    "myPropVec4",
    () => this.myVec4,
    (newValue) => (this.myVec4 = newValue)
  )
  private myPropVec4Array = StorageProperty.autoVec4Array(
    "myPropVec4Array",
    () => this.myVec4Array,
    (newValue) => (this.myVec4Array = newValue)
  )

  private myPropQuat = StorageProperty.autoQuat(
    "myPropQuat",
    () => this.myQuat,
    (newValue) => (this.myQuat = newValue)
  )
  private myPropQuatArray = StorageProperty.autoQuatArray(
    "myPropQuatArray",
    () => this.myQuatArray,
    (newValue) => (this.myQuatArray = newValue)
  )

  private myPropMat2 = StorageProperty.autoMat2(
    "myPropMat2",
    () => this.myMat2,
    (newValue) => (this.myMat2 = newValue)
  )
  private myPropMat2Array = StorageProperty.autoMat2Array(
    "myPropMat2Array",
    () => this.myMat2Array,
    (newValue) => (this.myMat2Array = newValue)
  )

  private myPropMat3 = StorageProperty.autoMat3(
    "myPropMat3",
    () => this.myMat3,
    (newValue) => (this.myMat3 = newValue)
  )
  private myPropMat3Array = StorageProperty.autoMat3Array(
    "myPropMat3Array",
    () => this.myMat3Array,
    (newValue) => (this.myMat3Array = newValue)
  )

  private myPropMat4 = StorageProperty.autoMat4(
    "myPropMat4",
    () => this.myMat4,
    (newValue) => (this.myMat4 = newValue)
  )
  private myPropMat4Array = StorageProperty.autoMat4Array(
    "myPropMat4Array",
    () => this.myMat4Array,
    (newValue) => (this.myMat4Array = newValue)
  )

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

        this.myInt = 1
        this.myIntArray = [1, 2]
        this.myString = "Goodbye, World!"
        this.myStringArray = ["Goodbye, World!"]
        this.myBool = false
        this.myBoolArray = [false]
        this.myFloat = Math.E
        this.myFloatArray = [Math.E]
        this.myDouble = Math.E
        this.myDoubleArray = [Math.E]
        this.myVec2 = new vec2(1, 2)
        this.myVec2Array = [new vec2(1, 2), new vec2(3, 4)]
        this.myVec3 = new vec3(1, 2, 3)
        this.myVec3Array = [new vec3(1, 2, 3), new vec3(4, 5, 6)]
        this.myVec4 = new vec4(1, 2, 3, 4)
        this.myVec4Array = [new vec4(1, 2, 3, 4), new vec4(5, 6, 7, 8)]
        this.myQuat = quat.fromEulerVec(new vec3(0, 0, 1))
        this.myQuatArray = [
          quat.fromEulerVec(new vec3(0, 0, 1)),
          quat.fromEulerVec(new vec3(0, 1, 0)),
        ]
        this.myMat2 = mat2.identity()
        this.myMat2Array = [mat2.identity(), mat2.identity()]
        this.myMat3 = mat3.identity()
        this.myMat3Array = [mat3.identity(), mat3.identity()]
        this.myMat4 = mat4.identity()
        this.myMat4Array = [mat4.identity(), mat4.identity()]
      },
      TEN_SECONDS_MS
    )
  }

  private onMyPropChanged<T>(newValue: T, oldValue: T): void {
    this.log.i(`My property changed from ${oldValue} to ${newValue}`)
  }
}
