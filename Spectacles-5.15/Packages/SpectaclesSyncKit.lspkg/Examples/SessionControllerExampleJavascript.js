function onReady() {
  print("Example Component: The session controller is ready!");
}

function onStart() {
  new SyncEntity(script, null, true);
  sessionController.notifyOnReady(onReady);
}

var onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
