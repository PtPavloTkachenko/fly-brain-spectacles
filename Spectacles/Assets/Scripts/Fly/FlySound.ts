/**
 * FlySound — each fly sounds like what its brain does (11.09 the user: "do the flies make sounds?"):
 *  - wing buzz, spatial, from the fly itself: volume follows the population rate of its 67 wing
 *    motor neurons (`hz.wing`, subclass "wm"), auto-ranged; silent when landed; loud on escape;
 *  - courtship song: plays only while the song command neuron pIP10 fires (`hz.song`).
 * Tracks are procedural (audio/gen_fly_sounds.py). AudioComponent has no pitch control in 5.15,
 * so the brain drives loudness only.
 */
import { BrainMsg } from "./BrainLink"
import { FlyBody } from "./FlyBody"
import { FlyConfig } from "./FlyConfig"

interface Voice {
  buzz: AudioComponent | null
  song: AudioComponent | null
  buzzVol: number
  songVol: number
  wingMax: number
  songBase: number // -1 until the first reading
}

export class FlySound {
  private voices: Voice[] = []
  private started = false
  private acc = 0 // seconds since the last volume update (SOUND_HZ, not the frame rate)

  constructor(roots: SceneObject[], private buzzTrack: AudioTrackAsset | null, private songTrack: AudioTrackAsset | null, cameraObject: SceneObject) {
    // A listener exists ONLY for spatial audio; with plain stereo nothing reads it (12.09).
    if (FlyConfig.SOUND_SPATIAL && !cameraObject.getComponent("Component.AudioListenerComponent")) {
      cameraObject.createComponent("Component.AudioListenerComponent")
    }
    for (const root of roots) {
      const so = global.scene.createSceneObject("FlyAudio")
      so.setParent(root)
      this.voices.push({
        buzz: buzzTrack ? this.make(so, buzzTrack) : null,
        song: songTrack ? this.make(so, songTrack) : null,
        buzzVol: 0,
        songVol: 0,
        wingMax: FlyConfig.SOUND_WING_FLOOR_HZ,
        songBase: -1,
      })
    }
  }

  private make(so: SceneObject, track: AudioTrackAsset): AudioComponent {
    const a = so.createComponent("Component.AudioComponent") as AudioComponent
    a.audioTrack = track
    a.volume = 0
    try {
      // 12.09 the user: "turn spatial audio off, just do distance-based volume." It already was
      // distance-based — `distanceGain` in tick() is ours and stays — so all `spatialAudio` added
      // on top was the positional (left/right, front/back) effect, per voice, per frame.
      a.spatialAudio.enabled = FlyConfig.SOUND_SPATIAL
      a.spatialAudio.positionEffect.enabled = FlyConfig.SOUND_SPATIAL
      a.spatialAudio.distanceEffect.enabled = false
    } catch (e) {
      /* spatial audio unavailable: plain stereo */
    }
    return a
  }

  status(): string {
    const v = this.voices[0]
    return v ? "buzz=" + v.buzzVol.toFixed(2) + " song=" + v.songVol.toFixed(2) + " wingMax=" + v.wingMax.toFixed(0) : "none"
  }

  /** Loudness vs distance to the listener: full within SOUND_NEAR_CM, silent past SOUND_FAR_CM. */
  private distanceGain(d: number): number {
    const k = Math.max(0, Math.min(1, (FlyConfig.SOUND_FAR_CM - d) / (FlyConfig.SOUND_FAR_CM - FlyConfig.SOUND_NEAR_CM)))
    return k * k // perceptually closer to inverse-distance than a straight ramp
  }

  tick(dt: number, flies: FlyBody[], msgs: (BrainMsg | null)[], muted: boolean, listener: vec3) {
    if (!this.started && !muted) {
      // loops start once (at volume 0) after the intro; loudness does the rest
      for (const v of this.voices) {
        if (v.buzz) v.buzz.play(-1)
        if (v.song) v.song.play(-1)
      }
      this.started = true
    }
    // 12.09 the user: "do distanceGain at a low rate, not 60 fps". Loudness is a slow signal and each
    // step writes two AudioComponent volumes per fly straight into the engine. Every easing here
    // is already a rate (1 - exp(-dt * r)), so running on the ACCUMULATED dt leaves every time
    // constant exactly as it was — only the number of writes drops.
    this.acc += dt
    if (this.acc < 1 / FlyConfig.SOUND_HZ) return
    const step = this.acc
    this.acc = 0
    const k = 1 - Math.exp(-step * FlyConfig.SOUND_EASE_RATE)
    for (let i = 0; i < this.voices.length && i < flies.length; i++) {
      const v = this.voices[i]
      const f = flies[i]
      const hz: any = msgs[i] ? (msgs[i] as any).hz : null
      const wing = hz && typeof hz.wing === "number" ? hz.wing : 0
      const song = hz && typeof hz.song === "number" ? hz.song : 0
      v.wingMax = Math.max(FlyConfig.SOUND_WING_FLOOR_HZ, v.wingMax * Math.exp(-step / 20), wing * 1.1)
      const flying = f.state !== "landed"
      // louder the faster it flies (11.09 the user: "sounds from speed too") on top of the wing-MN drive
      const sp = FlyConfig.SOUND_SPEED_MIN + (1 - FlyConfig.SOUND_SPEED_MIN) * Math.min(1, Math.abs(f.speed) / FlyConfig.CRUISE_CM_S)
      let buzz = muted || !flying ? 0 : FlyConfig.SOUND_BUZZ_VOL * (0.35 + 0.65 * Math.min(1, wing / v.wingMax)) * sp
      if (f.state === "escape") buzz = FlyConfig.SOUND_BUZZ_VOL * 1.4
      // pIP10 idles at ~13 Hz at rest: sing only ABOVE this fly's own slowly-tracked floor
      v.songBase = v.songBase < 0 ? song : song < v.songBase ? song : v.songBase + (song - v.songBase) * (step / 30)
      const excess = Math.max(0, song - v.songBase - FlyConfig.SOUND_SONG_MARGIN_HZ)
      const sing = muted ? 0 : FlyConfig.SOUND_SONG_VOL * Math.min(1, excess / FlyConfig.SOUND_SONG_FULL_HZ)
      const g = this.distanceGain(f.pos.distance(listener))
      v.buzzVol += (buzz * g - v.buzzVol) * k
      v.songVol += (sing * g - v.songVol) * k
      if (v.buzz) v.buzz.volume = v.buzzVol
      if (v.song) v.song.volume = v.songVol
    }
  }
}
