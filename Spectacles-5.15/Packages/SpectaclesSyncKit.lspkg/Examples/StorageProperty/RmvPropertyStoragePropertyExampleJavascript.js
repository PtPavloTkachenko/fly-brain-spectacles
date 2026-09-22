// @input Asset.RenderMeshVisual myRmv

const SyncKitLogger = require("../../Utils/SyncKitLogger").SyncKitLogger;

// The speed at which the property changes
const PROP_CHANGE_SPEED = 1;

const log = new SyncKitLogger("RmvPropertyStoragePropertyExampleJavascript");

let myPropRmv = null;
let myStoragePropertySet = null;
let syncEntity = null;

function onStart() {
  myPropRmv = StorageProperty.forMeshVisualProperty(
    script.myRmv,
    "stripes",
    StorageTypes.float,
    true,
  );
  myStoragePropertySet = new StoragePropertySet([myPropRmv]);
  syncEntity = new SyncEntity(script, myStoragePropertySet, true);

  script.myRmv.mainMaterial.mainPass.baseColor = new vec4(0, 1, 0, 1);
  script.createEvent("UpdateEvent").bind(updateProp);
}

function updateProp() {
  if (!syncEntity.doIOwnStore()) {
    log.i("Not the syncEntity owner, not changing anything.");
    return;
  }

  const stripes = (getTime() * PROP_CHANGE_SPEED) % 1;
  script.myRmv.mainMaterial.mainPass["stripes"] = stripes;
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
