// @input Asset.RenderMeshVisual myRmv

const SyncKitLogger = require("../../Utils/SyncKitLogger").SyncKitLogger;
const HSLToRGB = require("SpectaclesInteractionKit.lspkg/Utils/color").HSLToRGB;

// The speed at which the hue changes
const COLOR_CHANGE_SPEED = 30;

const log = new SyncKitLogger("ColorStoragePropertyExampleJavascript");

let myPropRmv = null;
let myStoragePropertySet = null;
let syncEntity = null;

function onStart() {
  myPropRmv = StorageProperty.forMeshVisualBaseColor(script.myRmv, true);
  myStoragePropertySet = new StoragePropertySet([myPropRmv]);
  syncEntity = new SyncEntity(script, myStoragePropertySet, true);

  script.createEvent("UpdateEvent").bind(updateColor);
}

function updateColor() {
  if (!syncEntity.doIOwnStore()) {
    log.i("Not the syncEntity owner, not changing anything.");
    return;
  }

  const numChars = getTime() * COLOR_CHANGE_SPEED;
  const newColor = HSLToRGB(new vec3(numChars % 360, 1, 0.5));
  script.myRmv.mainMaterial.mainPass.baseColor = new vec4(newColor.x, newColor.y, newColor.z, 1);
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
