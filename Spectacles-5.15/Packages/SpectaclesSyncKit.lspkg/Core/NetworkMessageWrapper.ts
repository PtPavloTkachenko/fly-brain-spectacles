import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {KeyedEventWrapper} from "./KeyedEventWrapper"
import {NetworkMessage} from "./NetworkMessage"
import {lsJSONParse, lsJSONStringify, NETWORK_ID_KEY} from "./NetworkUtils"
import {SessionController} from "./SessionController"

/**
 * Wraps network messages for a specific kind of message.
 */
export class NetworkMessageWrapper<T> {
  private log = new SyncKitLogger("NetworkMessageWrapper")

  onRemoteEventReceived = new KeyedEventWrapper<[NetworkMessage<T>]>()
  onAnyEventReceived = new KeyedEventWrapper<[NetworkMessage<T>]>()

  cleanupMessage: (
    arg0: MultiplayerSession,
    arg1: string,
    arg2: string,
    arg3: ConnectedLensModule.UserInfo,
  ) => void

  constructor(public networkId: string) {
    this.cleanupMessage = SessionController.getInstance().onMessageReceived.add(
      (session, senderId, messageString, senderInfo) =>
        this._onReceiveMessage(session, senderId, messageString, senderInfo),
    )
  }

  /**
   * Handles the reception of a network message.
   * @param _session - The multiplayer session.
   * @param _senderId - The sender's ID.
   * @param messageString - The message content.
   * @param senderInfo - Information about the sender.
   */
  private _onReceiveMessage(
    _session: MultiplayerSession,
    _senderId: string,
    messageString: string,
    senderInfo: ConnectedLensModule.UserInfo,
  ) {
    let obj = null
    try {
      obj = lsJSONParse(messageString)

      // Ignore this error to make it easier to uncomment the error logging in the catch block.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      /*
       * Messages may not be in json if they are not from SyncKit, so we should ignore them if there is a problem.
       * If you are having a problem with message deserialization, uncomment this line for better error messages
       * this.log.e("could not parse message: " + e);
       */
      return
    }
    const networkId = obj[NETWORK_ID_KEY]
    if (networkId === this.networkId) {
      const messageKey = obj._message
      if (messageKey !== undefined) {
        const messageData = obj._data
        this._dispatchMessageEvents(senderInfo, messageKey, messageData)
      }
    }
  }

  /**
   * Dispatches the received message events.
   * @param senderInfo - Information about the sender.
   * @param messageKey - The message key.
   * @param messageData - The message data.
   */
  private _dispatchMessageEvents(
    senderInfo: ConnectedLensModule.UserInfo,
    messageKey: string,
    messageData?: T,
  ) {
    const netEvent = new NetworkMessage(senderInfo, messageKey, messageData)
    const senderId = senderInfo.connectionId
    if (senderId != SessionController.getInstance().getLocalConnectionId()) {
      this.onRemoteEventReceived.trigger(messageKey, netEvent)
    }
    this.onAnyEventReceived.trigger(messageKey, netEvent)
  }

  /**
   * Sends a network message.
   * @param messageKey - The message key.
   * @param messageData - The message data.
   * @param onlySendRemote - If true, only send the message remotely.
   */
  sendMessage(messageKey: string, messageData?: T, onlySendRemote?: boolean) {
    const obj: {_message: string; _data?: T; [key: string]: any} = {
      _message: messageKey,
    }
    if (messageData !== undefined) {
      obj._data = messageData
    }
    obj[NETWORK_ID_KEY] = this.networkId
    const str = lsJSONStringify(obj)

    SessionController.getInstance().getSession().sendMessage(str)

    if (!onlySendRemote) {
      const senderInfo = SessionController.getInstance().getLocalUserInfo()
      this._dispatchMessageEvents(senderInfo, messageKey, messageData)
    }
  }

  /**
   * Cleans up the message wrapper by removing the message listener.
   */
  cleanup() {
    SessionController.getInstance().onMessageReceived.remove(
      this.cleanupMessage,
    )
  }
}
