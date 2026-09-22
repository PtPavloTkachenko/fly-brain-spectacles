/**
 * Converts a string to an Ownership enum.
 * @param type - The ownership type as a string.
 * @returns The ownership type as an Ownership enum.
 */
export function ownershipTypeFromString(
  type: string,
): RealtimeStoreCreateOptions.Ownership {
  switch (type.toLowerCase()) {
    case "owned":
      return RealtimeStoreCreateOptions.Ownership.Owned
    case "unowned":
      return RealtimeStoreCreateOptions.Ownership.Unowned
    default:
      throw new Error("Invalid ownership type: " + type)
  }
}
