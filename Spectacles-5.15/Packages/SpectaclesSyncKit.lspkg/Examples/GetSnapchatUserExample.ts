import {SessionController} from "../Core/SessionController"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

@component
export class GetSnapchatUserExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(GetSnapchatUserExample.name)

  onAwake(): void {
    print("GetSnapchatUserExample: onAwake called")
    const sessionController: SessionController = SessionController.getInstance()

    sessionController.notifyOnReady(() => this.onReady())
  }

  private onReady(): void {
    print("GetSnapchatUserExample: onReady called")
    const session = SessionController.getInstance().getSession()
    if (!session) {
      this.log.e("No session available")
      return
    }

    const localUserInfo = SessionController.getInstance().getLocalUserInfo()
    if (!localUserInfo) {
      this.log.e("No local user info available")
      return
    }

    // MultiplayerSession.getSnapchatUser(UserInfo, callback)
    // In singleplayer/offline mode, the mock will pass null to the callback.
    session.getSnapchatUser(localUserInfo, (snapchatUser: SnapchatUser) => {
      if (!snapchatUser) {
        this.log.i("getSnapchatUser returned null (expected in singleplayer/offline). Use null for Bitmoji APIs.")
        return
      }
      const name = snapchatUser.displayName || snapchatUser.userName || "<unknown>"
      this.log.i("Got SnapchatUser: " + name + ", hasBitmoji=" + snapchatUser.hasBitmoji)
    })
  }
}
