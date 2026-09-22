import {ArrowType} from "./ArrowAnimator"
import {GuidanceCopy} from "./SimplifiedLandmarkGuidance"

export const DefaultGuidanceCopy: GuidanceCopy = {
  guidance: {
    displayTimeSeconds: 6,
    fadeInTimeSeconds: 0.6,
    hints: [
      {text: "Walk around and look around\nto join the experience", arrows: ArrowType.None},
      {text: "Move slowly and steadily", arrows: ArrowType.FigureEightXZ},
      {text: "Look up, down, left, and right", arrows: ArrowType.FigureEightXY}
    ]
  },
  troubleshooting: {
    title: "Couldn't find the location",
    bullets: [
      {title: "•   Look around the area", description: "Look up, down, left, and right."},
      {title: "•   Walk around slowly", description: "Try moving at a slower pace."},
      {title: "•   Move steadily", description: "Avoid sudden changes in direction."},
      {title: "•   Check lighting conditions", description: "Bright lighting improves feature detection."}
    ],
    button: "Keep Looking"
  },
  success: {
    text: "You're all set!"
  }
}
