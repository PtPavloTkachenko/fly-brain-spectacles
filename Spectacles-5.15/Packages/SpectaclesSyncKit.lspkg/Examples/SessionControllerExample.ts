import {SessionController} from "../Core/SessionController"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

@component
export class SessionControllerExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    SessionControllerExample.name
  )

  onAwake(): void {
    const sessionController: SessionController = SessionController.getInstance()

    sessionController.notifyOnReady(() => this.onReady())
  }

  onReady(): void {
    this.log.i("Example Component: The session controller is ready!")
  }
}
