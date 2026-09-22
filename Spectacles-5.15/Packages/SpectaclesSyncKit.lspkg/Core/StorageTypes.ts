import {
  computeInnerQuadrangleQuaternion,
  cubicInterpolate,
  exactArrayCompare,
  exactCompare,
  floatArrayCompare,
  floatCompare,
  lerp,
  matArrayCompare,
  matCompare,
  packedTransformCompare,
  packedTransformLerp,
  quatArrayCompare,
  quatCompare,
  quatSlerp,
  squad,
  tangent,
  vec2CubicInterpolate,
  vec2Lerp,
  vec2Tangent,
  vec3CubicInterpolate,
  vec3Lerp,
  vec3Tangent,
  vec4CubicInterpolate,
  vec4Lerp,
  vec4Tangent,
  vecArrayCompare,
  vecCompare,
} from "./StorageProperty"

/**
 * Storage types, for use with {@link StorageProperty}
 */
export enum StorageTypes {
  bool = "Bool",
  float = "Float",
  double = "Double",
  int = "Int",
  string = "String",
  vec2 = "Vec2",
  vec3 = "Vec3",
  vec4 = "Vec4",
  quat = "Quat",
  mat2 = "Mat2",
  mat3 = "Mat3",
  mat4 = "Mat4",
  boolArray = "BoolArray",
  floatArray = "FloatArray",
  doubleArray = "DoubleArray",
  intArray = "IntArray",
  stringArray = "StringArray",
  vec2Array = "Vec2Array",
  vec3Array = "Vec3Array",
  vec4Array = "Vec4Array",
  quatArray = "QuatArray",
  mat2Array = "Mat2Array",
  mat3Array = "Mat3Array",
  mat4Array = "Mat4Array",
  packedTransform = "packedTransform",
}

export type BaseStorageTypes = Exclude<StorageTypes, `${string}Array`>

export type StorageTypeToPrimitive = {
  [StorageTypes.string]: string
  [StorageTypes.bool]: boolean
  [StorageTypes.int]: number
  [StorageTypes.float]: number
  [StorageTypes.double]: number
  [StorageTypes.quat]: quat
  [StorageTypes.vec2]: vec2
  [StorageTypes.vec3]: vec3
  [StorageTypes.vec4]: vec4
  [StorageTypes.mat2]: mat2
  [StorageTypes.mat3]: mat3
  [StorageTypes.mat4]: mat4
  [StorageTypes.boolArray]: boolean[]
  [StorageTypes.intArray]: number[]
  [StorageTypes.floatArray]: number[]
  [StorageTypes.doubleArray]: number[]
  [StorageTypes.stringArray]: string[]
  [StorageTypes.vec2Array]: vec2[]
  [StorageTypes.vec3Array]: vec3[]
  [StorageTypes.vec4Array]: vec4[]
  [StorageTypes.quatArray]: quat[]
  [StorageTypes.mat2Array]: mat2[]
  [StorageTypes.mat3Array]: mat3[]
  [StorageTypes.mat4Array]: mat4[]
  [StorageTypes.packedTransform]: vec4[]
}

export type NonArrayStorageTypePrimitive<TStorageType extends StorageTypes = StorageTypes> = StorageTypeToPrimitive[TStorageType extends Extract<keyof StorageTypeToPrimitive, BaseStorageTypes> ? TStorageType : never]
export type ArrayStorageTypePrimitive<TStorageType extends StorageTypes = StorageTypes> = StorageTypeToPrimitive[TStorageType extends Exclude<keyof StorageTypeToPrimitive, BaseStorageTypes> ? TStorageType : never]

/**
 * Returns an equal check function based on `storageType`.
 * This function returns `true` if the two values of that type can be considered equal, or reasonably close to equal.
 * @param storageType - storageType to get an equals check for
 * @returns Equals check function for the passed in {@link StorageTypes | StorageType}
 */
export function getEqualsCheckForStorageType<TStorageType extends StorageTypes>(
  storageType: TStorageType
): (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean {
  switch (storageType) {
    case StorageTypes.string:
    case StorageTypes.bool:
    case StorageTypes.int:
      return exactCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.float:
    case StorageTypes.double:
      return floatCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.quat:
      return quatCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.vec2:
    case StorageTypes.vec3:
    case StorageTypes.vec4:
      return vecCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.mat2:
    case StorageTypes.mat3:
    case StorageTypes.mat4:
      return matCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.intArray:
    case StorageTypes.boolArray:
    case StorageTypes.stringArray:
      return exactArrayCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.floatArray:
    case StorageTypes.doubleArray:
      return floatArrayCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.quatArray:
      return quatArrayCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.vec2Array:
    case StorageTypes.vec3Array:
    case StorageTypes.vec4Array:
      return vecArrayCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.mat2Array:
    case StorageTypes.mat3Array:
    case StorageTypes.mat4Array:
      return matArrayCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    case StorageTypes.packedTransform:
      return packedTransformCompare as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType]) => boolean
    default:
      throw new Error("No equals check for storage type: " + storageType)
  }
}

/**
 * Returns a lerp function based on `storageType`.
 * @param storageType - storageType to get lerp function for
 * @returns Lerp function for the passed in {@link StorageTypes | StorageType}
 */
export function getLerpForStorageType<TStorageType extends StorageTypes>(
  storageType: TStorageType
): (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType] {
  switch (storageType) {
    case StorageTypes.float:
    case StorageTypes.double:
      return lerp as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.quat:
      return quatSlerp as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec2:
      return vec2Lerp as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec3:
      return vec3Lerp as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec4:
      return vec4Lerp as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.packedTransform:
      return packedTransformLerp as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    default:
      throw new Error("No lerp for storage type: " + storageType)
  }
}

/**
 * Returns a cubic interpolation function based on `storageType`.
 * @param storageType - storageType to get cubic interpolation function for
 * @returns Cubic interpolation function for the passed in {@link StorageTypes | StorageType}
 */
export function getCubicInterpolateForStorageType<TStorageType extends StorageTypes>(
  storageType: StorageTypes
): (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], d: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType] {
  switch (storageType) {
    case StorageTypes.float:
    case StorageTypes.double:
      return cubicInterpolate as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], d: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.quat:
      return squad as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], d: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec2:
      return vec2CubicInterpolate as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], d: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec3:
      return vec3CubicInterpolate as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], d: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec4:
      return vec4CubicInterpolate as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], d: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.packedTransform:
      throw new Error("Not implemented.")
    default:
      throw new Error("No cubic interpolation for storage type: " + storageType)
  }
}

/**
 * Returns a tangent function based on `storageType`.
 * @param storageType - storageType to get tangent function for
 * @returns Tangent function for the passed in {@link StorageTypes | StorageType}
 */
export function getTangentForStorageType<TStorageType extends StorageTypes>(
  storageType: StorageTypes
): (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType] {
  switch (storageType) {
    case StorageTypes.float:
    case StorageTypes.double:
      return tangent as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.quat:
      return computeInnerQuadrangleQuaternion as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType]) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec2:
      return vec2Tangent as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec3:
      return vec3Tangent as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.vec4:
      return vec4Tangent as (a: StorageTypeToPrimitive[TStorageType], b: StorageTypeToPrimitive[TStorageType], c: StorageTypeToPrimitive[TStorageType], t: number) => StorageTypeToPrimitive[TStorageType]
    case StorageTypes.packedTransform:
      throw new Error("Not implemented.")
    default:
      throw new Error("No tangent for storage type: " + storageType)
  }
}

/**
 * Returns the base StorageType (useful for Array types)
 * @param storageType - storageType to find base StorageType of
 * @returns Base {@link StorageTypes | StorageType}
 */
export function getBaseStorageType(
  storageType: StorageTypes
): BaseStorageTypes {
  switch (storageType) {
    case StorageTypes.boolArray:
      return StorageTypes.bool
    case StorageTypes.intArray:
      return StorageTypes.int
    case StorageTypes.floatArray:
      return StorageTypes.float
    case StorageTypes.doubleArray:
      return StorageTypes.double
    case StorageTypes.stringArray:
      return StorageTypes.string
    case StorageTypes.vec2Array:
      return StorageTypes.vec2
    case StorageTypes.vec3Array:
      return StorageTypes.vec3
    case StorageTypes.vec4Array:
      return StorageTypes.vec4
    case StorageTypes.quatArray:
      return StorageTypes.quat
    case StorageTypes.mat2Array:
      return StorageTypes.mat2
    case StorageTypes.mat3Array:
      return StorageTypes.mat3
    case StorageTypes.mat4Array:
      return StorageTypes.mat4
    case StorageTypes.packedTransform:
      return StorageTypes.packedTransform
    default:
      return storageType
  }
}

/**
 * Returns true if the storageType is an array type
 * @param storageType - storageType to check if it is an array type
 * @returns True if the storageType is an array type
 */
export function isArrayType(storageType: StorageTypes): boolean {
  const baseType = getBaseStorageType(storageType)
  return baseType !== storageType
}

;(global as any).StorageTypes = StorageTypes
