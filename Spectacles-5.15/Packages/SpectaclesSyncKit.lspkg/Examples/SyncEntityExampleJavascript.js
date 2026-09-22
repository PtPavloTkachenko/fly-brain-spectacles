function onReady() {
  print("Example Component: The sync entity is ready!");
}

function onStart() {
  var syncEntity = new SyncEntity(script, null, true);
  syncEntity.notifyOnReady(onReady);
}

var onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
