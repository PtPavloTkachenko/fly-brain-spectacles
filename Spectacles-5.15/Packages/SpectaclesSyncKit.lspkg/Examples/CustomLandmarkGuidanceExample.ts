/**
 * Minimal usage example: assumes a scene object has the CustomLandmarkGuidanceBinding
 * with all inputs wired, and a LocatedAtComponent set via inspector.
 */
import {CustomLandmarkGuidanceBinding} from "../CustomLandmarkGuidance/CustomLandmarkGuidanceBinding"

@component
export class CustomLandmarkGuidanceExample extends BaseScriptComponent {
  @input
  private readonly binding: CustomLandmarkGuidanceBinding

  onAwake() {
    // Nothing here; binding manages lifecycle via OnStart and LocatedAt events
  }
}

