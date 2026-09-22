function onStart() {
  print("GetSnapchatUserExample: onAwake called");
  global.sessionController.notifyOnReady(onReady);
}

function onReady() {
  print("GetSnapchatUserExample: onReady called");
  const session = global.sessionController.getSession();
  if (!session) {
    print("No session available");
    return;
  }

  const localUserInfo = global.sessionController.getLocalUserInfo();
  if (!localUserInfo) {
    print("No local user info available");
    return;
  }

  // MultiplayerSession.getSnapchatUser(UserInfo, callback)
  // In singleplayer/offline mode, the mock will pass null to the callback.
  session.getSnapchatUser(localUserInfo, function (snapchatUser) {
    if (!snapchatUser) {
      print(
        "getSnapchatUser returned null (expected in singleplayer/offline). Use null for Bitmoji APIs.",
      );
      return;
    }
    const name =
      snapchatUser.displayName || snapchatUser.userName || "<unknown>";
    print(
      "Got SnapchatUser: " + name + ", hasBitmoji=" + snapchatUser.hasBitmoji,
    );
  });
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);


