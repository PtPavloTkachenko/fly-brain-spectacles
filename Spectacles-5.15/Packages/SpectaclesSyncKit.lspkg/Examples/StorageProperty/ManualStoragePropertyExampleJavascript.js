SyncKitLogger = require("../../Utils/SyncKitLogger").SyncKitLogger;

// Ten seconds in seconds
const TEN_SECONDS_S = 10;

const log = new SyncKitLogger("ManualStoragePropertyExampleJavascript");

var myPropInt = null;
var myPropIntArray = null;

var myPropString = null;
var myPropStringArray = null;

var myPropBool = null;
var myPropBoolArray = null;

var myPropFloat = null;
var myPropFloatArray = null;

var myPropDouble = null;
var myPropDoubleArray = null;

var myPropVec2 = null;
var myPropVec2Array = null;

var myPropVec3 = null;
var myPropVec3Array = null;

var myPropVec4 = null;
var myPropVec4Array = null;

var myPropQuat = null;
var myPropQuatArray = null;

var myPropMat2 = null;
var myPropMat2Array = null;

var myPropMat3 = null;
var myPropMat3Array = null;

var myPropMat4 = null;
var myPropMat4Array = null;

var myStoragePropertySet = null;

var syncEntity = null;

function onStart() {
  myPropInt = StorageProperty.manualInt("myPropInt", 0);
  myPropIntArray = StorageProperty.manualIntArray("myPropIntArray", [0]);

  myPropString = StorageProperty.manualString("myPropString", "Hello, World!");
  myPropStringArray = StorageProperty.manualStringArray("myPropStringArray", [
    "Hello, World!",
  ]);

  myPropBool = StorageProperty.manualBool("myPropBool", true);
  myPropBoolArray = StorageProperty.manualBoolArray("myPropBoolArray", [true]);

  myPropFloat = StorageProperty.manualFloat("myPropFloat", Math.PI);
  myPropFloatArray = StorageProperty.manualFloatArray("myPropFloatArray", [
    Math.PI,
  ]);

  myPropDouble = StorageProperty.manualDouble("myPropDouble", Math.PI);
  myPropDoubleArray = StorageProperty.manualDoubleArray("myPropDoubleArray", [
    Math.PI,
  ]);

  myPropVec2 = StorageProperty.manualVec2("myPropVec2", vec2.zero());
  myPropVec2Array = StorageProperty.manualVec2Array("myPropVec2Array", [
    vec2.zero(),
  ]);

  myPropVec3 = StorageProperty.manualVec3("myPropVec3", vec3.zero());
  myPropVec3Array = StorageProperty.manualVec3Array("myPropVec3Array", [
    vec3.zero(),
  ]);

  myPropVec4 = StorageProperty.manualVec4("myPropVec4", vec4.zero());
  myPropVec4Array = StorageProperty.manualVec4Array("myPropVec4Array", [
    vec4.zero(),
  ]);

  myPropQuat = StorageProperty.manualQuat("myPropQuat", quat.quatIdentity());
  myPropQuatArray = StorageProperty.manualQuatArray("myPropQuatArray", [
    quat.quatIdentity(),
  ]);

  myPropMat2 = StorageProperty.manualMat2("myPropMat2", mat2.zero());
  myPropMat2Array = StorageProperty.manualMat2Array("myPropMat2Array", [
    mat2.zero(),
  ]);

  myPropMat3 = StorageProperty.manualMat3("myPropMat3", mat3.zero());
  myPropMat3Array = StorageProperty.manualMat3Array("myPropMat3Array", [
    mat3.zero(),
  ]);

  myPropMat4 = StorageProperty.manualMat4("myPropMat4", mat4.zero());
  myPropMat4Array = StorageProperty.manualMat4Array("myPropMat4Array", [
    mat4.zero(),
  ]);

  myStoragePropertySet = new StoragePropertySet([
    myPropInt,
    myPropIntArray,
    myPropString,
    myPropStringArray,
    myPropBool,
    myPropBoolArray,
    myPropFloat,
    myPropFloatArray,
    myPropDouble,
    myPropDoubleArray,
    myPropVec2,
    myPropVec2Array,
    myPropVec3,
    myPropVec3Array,
    myPropVec4,
    myPropVec4Array,
    myPropQuat,
    myPropQuatArray,
    myPropMat2,
    myPropMat2Array,
    myPropMat3,
    myPropMat3Array,
    myPropMat4,
    myPropMat4Array,
  ]);

  syncEntity = new SyncEntity(script, myStoragePropertySet, true);

  Object.values(myStoragePropertySet.storageProperties).forEach((property) => {
    // Can subscribe to changes at any time
    property.onAnyChange.add((newValue, oldValue) =>
      onMyPropChanged(newValue, oldValue),
    );
  });

  syncEntity.notifyOnReady(onReady.bind(this));
}

function onReady() {
  Object.values(myStoragePropertySet.storageProperties).forEach((property) => {
    // Wait until onReady before printing values
    log.i(
      `My property ${property.key} value starts as ${property.currentOrPendingValue}`,
    );
  });

  var delayedEvent = script.createEvent("DelayedCallbackEvent");
  delayedEvent.bind(onDelayedEvent);
  delayedEvent.reset(TEN_SECONDS_S);
}

function onDelayedEvent() {
  // After some time, change the value of the properties once to demonstrate how changing them works
  if (!syncEntity.doIOwnStore()) {
    log.i("Not the syncEntity owner, not changing properties.");
    return;
  }

  myPropInt.setPendingValue(1);
  myPropIntArray.setPendingValue([1]);
  myPropString.setPendingValue("Goodbye, World!");
  myPropStringArray.setPendingValue(["Goodbye, World!"]);
  myPropBool.setPendingValue(false);
  myPropBoolArray.setPendingValue([false]);
  myPropFloat.setPendingValue(Math.E);
  myPropFloatArray.setPendingValue([Math.E]);
  myPropDouble.setPendingValue(Math.E);
  myPropDoubleArray.setPendingValue([Math.E]);
  myPropVec2.setPendingValue(new vec2(1, 2));
  myPropVec2Array.setPendingValue([new vec2(1, 2), new vec2(3, 4)]);
  myPropVec3.setPendingValue(new vec3(1, 2, 3));
  myPropVec3Array.setPendingValue([new vec3(1, 2, 3), new vec3(4, 5, 6)]);
  myPropVec4.setPendingValue(new vec4(1, 2, 3, 4));
  myPropVec4Array.setPendingValue([new vec4(1, 2, 3, 4), new vec4(5, 6, 7, 8)]);
  myPropQuat.setPendingValue(quat.fromEulerVec(new vec3(0, 0, 1)));
  myPropQuatArray.setPendingValue([
    quat.fromEulerVec(new vec3(0, 0, 1)),
    quat.fromEulerVec(new vec3(0, 1, 0)),
  ]);
  myPropMat2.setPendingValue(mat2.identity());
  myPropMat2Array.setPendingValue([mat2.identity(), mat2.identity()]);
  myPropMat3.setPendingValue(mat3.identity());
  myPropMat3Array.setPendingValue([mat3.identity(), mat3.identity()]);
  myPropMat4.setPendingValue(mat4.identity());
  myPropMat4Array.setPendingValue([mat4.identity(), mat4.identity()]);
}

function onMyPropChanged(newValue, oldValue) {
  print(
    `Example Component: My property changed from ${oldValue} to ${newValue}`,
  );
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
