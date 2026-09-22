export type ArrayStorageType =
  | boolean[]
  | number[]
  | number[]
  | number[]
  | string[]
  | vec2[]
  | vec3[]
  | vec4[]
  | quat[]
  | mat2[]
  | mat3[]
  | mat4[]
  | vec4[]
export type SingularStorageType =
  | boolean
  | number
  | number
  | number
  | string
  | vec2
  | vec3
  | vec4
  | quat
  | mat2
  | mat3
  | mat4
export type ValidStorageType = SingularStorageType | ArrayStorageType
