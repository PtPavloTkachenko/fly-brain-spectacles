/**
 * The type of a transform property.
 */
export enum PropertyType {
  None,
  Local,
  World,
  Location,
}

/**
 * Converts a string to a PropertyType enum.
 * @param type - The property type as a string.
 * @returns The property type as a PropertyType enum.
 */
export function propertyTypeFromString(type: string): PropertyType {
  switch (type.toLowerCase()) {
    case "none":
      return PropertyType.None
    case "location":
      return PropertyType.Location
    case "local":
      return PropertyType.Local
    case "world":
      return PropertyType.World
    default:
      throw new Error("Invalid property type: " + type)
  }
}

;(global as any).PropertyType = PropertyType
