export enum NetworkIdType {
  Hierarchy,
  Custom,
  ObjectId,
}

export function networkIdFromString(type: string): NetworkIdType {
  switch (type.toLowerCase()) {
    case "hierarchy":
      return NetworkIdType.Hierarchy
    case "custom":
      return NetworkIdType.Custom
    case "objectid":
      return NetworkIdType.ObjectId
    default:
      throw new Error("Invalid network ID type: " + type)
  }
}
