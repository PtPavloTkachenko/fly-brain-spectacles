export function persistenceTypeFromString(
  type: string
): RealtimeStoreCreateOptions.Persistence {
  switch (type.toLowerCase()) {
    case "ephemeral":
      return RealtimeStoreCreateOptions.Persistence.Ephemeral
    case "owner":
      return RealtimeStoreCreateOptions.Persistence.Owner
    case "persist":
      return RealtimeStoreCreateOptions.Persistence.Persist
    case "session":
      return RealtimeStoreCreateOptions.Persistence.Session
    default:
      throw new Error("Invalid persistence type: " + type)
  }
}
