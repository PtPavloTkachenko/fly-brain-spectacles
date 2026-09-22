// @input Asset.Text myText

const SyncKitLogger = require("../../Utils/SyncKitLogger").SyncKitLogger;

// The text to scroll
const SCROLLING_TEXT = "Hello, World!";

// The speed at which the text scrolls
const TEXT_SCROLL_SPEED = 1;

const log = new SyncKitLogger("TextStoragePropertyExampleJavascript");

let myPropText = null;
let myStoragePropertySet = null;
let syncEntity = null;

function onStart() {
  myPropText = StorageProperty.forTextText(script.myText);
  myStoragePropertySet = new StoragePropertySet([myPropText]);
  syncEntity = new SyncEntity(script, myStoragePropertySet, true);

  script.createEvent("UpdateEvent").bind(updateText);
}

function updateText() {
  if (!syncEntity.doIOwnStore()) {
    log.i("Not the syncEntity owner, not changing anything.");
    return;
  }

  const numChars = (getTime() * TEXT_SCROLL_SPEED) % SCROLLING_TEXT.length;
  const newText = SCROLLING_TEXT.substring(0, numChars);
  script.myText.text = newText;
}

const onStartEvent = script.createEvent("OnStartEvent");
onStartEvent.bind(onStart);
