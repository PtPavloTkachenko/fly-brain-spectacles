@component
export class EnableObjectsOnAwake extends BaseScriptComponent {
    
  @input
  readonly objectsToEnable: SceneObject[]
  
  onAwake() {
    this.objectsToEnable.forEach(object => object.enabled = true)   
  }
}
