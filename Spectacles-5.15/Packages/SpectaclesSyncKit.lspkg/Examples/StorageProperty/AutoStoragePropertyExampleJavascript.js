const SyncKitLogger = require("../../Utils/SyncKitLogger").SyncKitLogger;

// Ten seconds in seconds
const TEN_SECONDS_S = 10;

const log = new SyncKitLogger("AutoStoragePropertyExampleJavascript");

var myInt = 0;
var myIntArray = [0];
var myFloat = Math.PI;
var myFloatArray = [Math.PI];
var myDouble = Math.PI;
var myDoubleArray = [Math.PI];
var myBool = false;
var myBoolArray = [false];
var myString = "Hello, World!";
var myStringArray = ["Hello, World!"];
var myVec2 = vec2.zero();
var myVec2Array = [vec2.zero()];
var myVec3 = vec3.zero();
var myVec3Array = [vec3.zero()];
var myVec4 = vec4.zero();
var myVec4Array = [vec4.zero()];
var myQuat = quat.quatIdentity();
var myQuatArray = [quat.quatIdentity()];
var myMat2 = mat2.zero();
var myMat2Array = [mat2.zero()];
var myMat3 = mat3.zero();
var myMat3Array = [mat3.zero()];
var myMat4 = mat4.zero();
var myMat4Array = [mat4.zero()];

var myPropInt = StorageProperty.autoInt(
  "myPropInt",
  () => myInt,
  (newValue) => (myInt = newValue),
);
var myPropIntArray = StorageProperty.autoIntArray(
  "myPropIntArray",
  () => myIntArray,
  (newValue) => (myIntArray = newValue),
);

var myPropString = StorageProperty.autoString(
  "myPropString",
  () => myString,
  (newValue) => (myString = newValue),
);
var myPropStringArray = StorageProperty.autoStringArray(
  "myPropStringArray",
  () => myStringArray,
  (newValue) => (myStringArray = newValue),
);

var myPropBool = StorageProperty.autoBool(
  "myPropBool",
  () => myBool,
  (newValue) => (myBool = newValue),
);
var myPropBoolArray = StorageProperty.autoBoolArray(
  "myPropBoolArray",
  () => myBoolArray,
  (newValue) => (myBoolArray = newValue),
);

var myPropFloat = StorageProperty.autoFloat(
  "myPropFloat",
  () => myFloat,
  (newValue) => (myFloat = newValue),
);
var myPropFloatArray = StorageProperty.autoFloatArray(
  "myPropFloatArray",
  () => myFloatArray,
  (newValue) => (myFloatArray = newValue),
);

var myPropDouble = StorageProperty.autoDouble(
  "myPropDouble",
  () => myDouble,
  (newValue) => (myDouble = newValue),
);
var myPropDoubleArray = StorageProperty.autoDoubleArray(
  "myPropDoubleArray",
  () => myDoubleArray,
  (newValue) => (myDoubleArray = newValue),
);

var myPropVec2 = StorageProperty.autoVec2(
  "myPropVec2",
  () => myVec2,
  (newValue) => (myVec2 = newValue),
);
var myPropVec2Array = StorageProperty.autoVec2Array(
  "myPropVec2Array",
  () => myVec2Array,
  (newValue) => (myVec2Array = newValue),
);

var myPropVec3 = StorageProperty.autoVec3(
  "myPropVec3",
  () => myVec3,
  (newValue) => (myVec3 = newValue),
);
var myPropVec3Array = StorageProperty.autoVec3Array(
  "myPropVec3Array",
  () => myVec3Array,
  (newValue) => (myVec3Array = newValue),
);

var myPropVec4 = StorageProperty.autoVec4(
  "myPropVec4",
  () => myVec4,
  (newValue) => (myVec4 = newValue),
);
var myPropVec4Array = StorageProperty.autoVec4Array(
  "myPropVec4Array",
  () => myVec4Array,
  (newValue) => (myVec4Array = newValue),
);

var myPropQuat = StorageProperty.autoQuat(
  "myPropQuat",
  () => myQuat,
  (newValue) => (myQuat = newValue),
);
var myPropQuatArray = StorageProperty.autoQuatArray(
  "myPropQuatArray",
  () => myQuatArray,
  (newValue) => (myQuatArray = newValue),
);

var myPropMat2 = StorageProperty.autoMat2(
  "myPropMat2",
  () => myMat2,
  (newValue) => (myMat2 = newValue),
);
var myPropMat2Array = StorageProperty.autoMat2Array(
  "myPropMat2Array",
  () => myMat2Array,
  (newValue) => (myMat2Array = newValue),
);

var myPropMat3 = StorageProperty.autoMat3(
  "myPropMat3",
  () => myMat3,
  (newValue) => (myMat3 = newValue),
);
var myPropMat3Array = StorageProperty.autoMat3Array(
  "myPropMat3Array",
  () => myMat3Array,
  (newValue) => (myMat3Array = newValue),
);

var myPropMat4 = StorageProperty.autoMat4(
  "myPropMat4",
  () => myMat4,
  (newValue) => (myMat4 = newValue),
);
var myPropMat4Array = StorageProperty.autoMat4Array(
  "myPropMat4Array",
  () => myMat4Array,
  (newValue) => (myMat4Array = newValue),
);

var myStoragePropertySet = new StoragePropertySet([
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

var syncEntity = null;

function onStart() {
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

  myInt = 1;
  myIntArray = [1, 2];
  myString = "Goodbye, World!";
  myStringArray = ["Goodbye, World!"];
  myBool = false;
  myBoolArray = [false];
  myFloat = Math.E;
  myFloatArray = [Math.E];
  myDouble = Math.E;
  myDoubleArray = [Math.E];
  myVec2 = new vec2(1, 2);
  myVec2Array = [new vec2(1, 2), new vec2(3, 4)];
  myVec3 = new vec3(1, 2, 3);
  myVec3Array = [new vec3(1, 2, 3), new vec3(4, 5, 6)];
  myVec4 = new vec4(1, 2, 3, 4);
  myVec4Array = [new vec4(1, 2, 3, 4), new vec4(5, 6, 7, 8)];
  myQuat = quat.fromEulerVec(new vec3(0, 0, 1));
  myQuatArray = [
    quat.fromEulerVec(new vec3(0, 0, 1)),
    quat.fromEulerVec(new vec3(0, 1, 0)),
  ];
  myMat2 = mat2.identity();
  myMat2Array = [mat2.identity(), mat2.identity()];
  myMat3 = mat3.identity();
  myMat3Array = [mat3.identity(), mat3.identity()];
  myMat4 = mat4.identity();
  myMat4Array = [mat4.identity(), mat4.identity()];
}

function onMyPropChanged(newValue, oldValue) {
  print(
    `Example Component: My property changed from ${oldValue} to ${newValue}`,
  );
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
