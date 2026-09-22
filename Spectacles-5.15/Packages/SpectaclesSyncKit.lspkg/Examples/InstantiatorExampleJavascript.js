// @typename Instantiator
// @input Instantiator instantiator
// @input Asset.ObjectPrefab prefab

function onReady() {
  print("Example Component: The prefab is ready!");
  script.instantiator.instantiate(
    script.prefab,
    new InstantiationOptions(),
    () => {
      print("Instantiation complete!");
    },
  );
}

function onStart() {
  script.instantiator.notifyOnReady(onReady);
}

var onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
