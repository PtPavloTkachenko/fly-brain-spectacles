const SyncKitLogger = require("../../Utils/SyncKitLogger").SyncKitLogger;

// The rotation speed of the circle to move the object in
const CIRCLE_ROTATION_SPEED = -1;

// The radius of the circle to move the object in
const CIRCLE_RADIUS_CM = 50;

// Maximum size of the object
const MAX_SIZE = 5;

const log = new SyncKitLogger("TransformStoragePropertyExampleJavascript");

let myPropTransform = null;
let myStoragePropertySet = null;
let syncEntity = null;

function onStart() {
  myPropTransform = StorageProperty.forTransform(
    script,
    PropertyType.Location,
    PropertyType.Location,
    PropertyType.Location,
    // Demonstrate how to apply smoothing
    {
      interpolationTarget: -0.25,
    },
  );
  myStoragePropertySet = new StoragePropertySet([myPropTransform]);
  syncEntity = new SyncEntity(script, myStoragePropertySet, true);

  // Demonstrate the effect of limiting the number of sends per second
  myPropTransform.sendsPerSecondLimit = 3;

  script.createEvent("UpdateEvent").bind(updateTransform);
}

function updateTransform() {
  if (!syncEntity.doIOwnStore()) {
    log.i("Not the syncEntity owner, not changing anything.");
    return;
  }

  const angle = getTime() * CIRCLE_ROTATION_SPEED;
  const x = CIRCLE_RADIUS_CM * Math.cos(angle);
  const y = CIRCLE_RADIUS_CM * Math.sin(angle);

  script.getTransform().setLocalPosition(new vec3(x, y, 0));

  const rotation = quat.fromEulerVec(new vec3(0, 0, angle));
  script.getTransform().setLocalRotation(rotation);

  const size = vec3.one().uniformScale(getTime() % MAX_SIZE);
  script.getTransform().setLocalScale(size);
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
