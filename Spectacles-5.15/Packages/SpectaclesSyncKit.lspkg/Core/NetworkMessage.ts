/**
 * Holds a message that is sent over the network.
 */
export class NetworkMessage<T> {
  /**
   * The user ID of the sender.
   */
  senderUserId: string

  /**
   * The connection ID of the sender.
   */
  senderConnectionId: string

  /**
   * The message content.
   */
  message: string

  /**
   * The message data.
   */
  data: T

  /**
   * @param senderInfo - Information about the sender.
   * @param message - The message content.
   * @param messageData - The message data.
   */
  constructor(
    public readonly senderInfo: ConnectedLensModule.UserInfo,
    message: string,
    messageData?: T,
  ) {
    this.senderUserId = senderInfo.userId
    this.senderConnectionId = senderInfo.connectionId
    this.message = message
    this.data = messageData
  }
}
