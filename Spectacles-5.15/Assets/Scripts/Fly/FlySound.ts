/**
 * FlySound — each fly sounds like what its brain does (11.09 Pavlo: "do the flies make sounds?"):
 *  - wing buzz from the fly itself: volume follows the population rate of its 67 wing motor
 *    neurons (`hz.wing`, subclass "wm"), auto-ranged; silent when landed; loud on escape;
 *  - courtship song: plays only while the song command neuron pIP10 fires (`hz.song`).
 * Tracks are procedural (audio/gen_fly_sounds.py). AudioComponent has no pitch control in 5.15,
 * so the brain drives loudness only. Distance is ours too (`distanceGain`, ADR 91): the engine's
 * spatial DistanceEffect stays off, so the curve below is the whole story.
 *
 * Log markers: SOUND_READY once (tracks present? spatial? curve), SOUND_START when the loops
 * start after the intro, SOUND_NO_TRACK if nothing was wired, and a throttled SOUND row
 * (wing Hz, speed, distance, gain, volume per fly) every SOUND_LOG_S while telemetry is on.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { BrainMsg } from "./BrainLink"
import { FlyBody } from "./FlyBody"
import { FlyConfig } from "./FlyConfig"

const TAG = "FlySound"
const log = new NativeLogger(TAG)

interface Voice {
  buzz: AudioComponent | null
  song: AudioComponent | null
  buzzVol: number
  songVol: number
  wingMax: number
  songBase: number // -1 until the first reading
  dist: number // last distance to the listener, cm (for status / the SOUND row)
  gain: number // last distanceGain
  wing: number // last hz.wing
}

export class FlySound {
  private voices: Voice[] = []
  private started = false
  private acc = 0 // seconds since the last volume update (SOUND_HZ, not the frame rate)
  private logAcc = 0 // seconds since the last SOUND row

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
        dist: 0,
        gain: 0,
        wing: 0,
      })
    }
    // One line that says whether there is anything to hear at all: an unassigned track is silence
    // with no error anywhere else (21.09: the wav files had left the project, the scene still
    // pointed at their ids, and FlySwarm quietly never built this class).
    if (!buzzTrack && !songTrack) log.w("SOUND_NO_TRACK neither buzzTrack nor songTrack is assigned on FlySwarm")
    log.i(
      "SOUND_READY flies=" + roots.length + " buzz=" + (buzzTrack ? "yes" : "NO") + " song=" + (songTrack ? "yes" : "NO") +
        " spatial=" + FlyConfig.SOUND_SPATIAL + " vol=" + FlyConfig.SOUND_BUZZ_VOL + " near=" + FlyConfig.SOUND_NEAR_CM +
        "cm far=" + FlyConfig.SOUND_FAR_CM + "cm fade=" + FlyConfig.SOUND_FADE_CM + "cm rolloff=" + FlyConfig.SOUND_ROLLOFF +
        " g(1m)=" + this.distanceGain(100).toFixed(2) + " g(2m)=" + this.distanceGain(200).toFixed(2) +
        " g(3m)=" + this.distanceGain(300).toFixed(2) + " g(4m)=" + this.distanceGain(400).toFixed(2)
    )
  }

  private make(so: SceneObject, track: AudioTrackAsset): AudioComponent {
    const a = so.createComponent("Component.AudioComponent") as AudioComponent
    a.audioTrack = track
    a.volume = 0
    // playbackMode stays the default LowPower: a continuous loop whose loudness is eased, not a
    // reaction sound (the d.ts recommends LowLatency only for "immediate auditory reaction").
    try {
      // 12.09 Pavlo: "turn spatial audio off, just do distance-based volume." It already was
      // distance-based — `distanceGain` in tick() is ours and stays — so all `spatialAudio` added
      // on top was the positional (left/right, front/back) effect, per voice, per frame.
      // The engine's DistanceEffect is OFF on purpose even with spatial on: its default maxDistance
      // is 100 cm, which would silence the fly a metre away; our curve is the one that counts.
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
    return v
      ? "buzz=" + v.buzzVol.toFixed(2) + " song=" + v.songVol.toFixed(2) + " wingMax=" + v.wingMax.toFixed(0) + " d=" + v.dist.toFixed(0) + " g=" + v.gain.toFixed(2)
      : "none"
  }

  /**
   * Loudness vs distance to the listener (ADR 91). Full within SOUND_NEAR_CM, then an
   * inverse-distance law (NEAR / d) ^ SOUND_ROLLOFF — a giant fly a metre away is loud, half as
   * loud at two — with a smooth fade over the last SOUND_FADE_CM before SOUND_FAR_CM, silent past it.
   * The old (FAR - d) / (FAR - NEAR) squared ramp was 0.09 at 3 m and 0 at 4 m: inaudible on the
   * glasses' speakers for most of the room.
   */
  private distanceGain(d: number): number {
    const near = FlyConfig.SOUND_NEAR_CM
    const far = FlyConfig.SOUND_FAR_CM
    if (d >= far) return 0
    let g = d <= near ? 1 : Math.pow(near / d, FlyConfig.SOUND_ROLLOFF)
    const fade = FlyConfig.SOUND_FADE_CM
    if (fade > 0 && d > far - fade) {
      const t = (far - d) / fade
      g *= t * t * (3 - 2 * t) // smoothstep to 0 at FAR
    }
    return g
  }

  tick(dt: number, flies: FlyBody[], msgs: (BrainMsg | null)[], muted: boolean, listener: vec3) {
    if (!this.started && !muted) {
      // loops start once (at volume 0) after the intro; loudness does the rest
      let n = 0
      for (const v of this.voices) {
        if (v.buzz) { v.buzz.play(-1); n++ }
        if (v.song) { v.song.play(-1); n++ }
      }
      this.started = true
      log.i("SOUND_START loops=" + n)
    }
    // 12.09 Pavlo: "do distanceGain at a low rate, not 60 fps". Loudness is a slow signal and each
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
      // auto-range against this fly's own recent peak (forgets over SOUND_WING_PEAK_TAU_S), never
      // below SOUND_WING_FLOOR_HZ: the wing MNs run 28-48 Hz in flight (measured), so a 5 Hz floor
      // made the first reading "the peak" and an escape burst dimmed the next 20 s of flight
      v.wingMax = Math.max(FlyConfig.SOUND_WING_FLOOR_HZ, v.wingMax * Math.exp(-step / FlyConfig.SOUND_WING_PEAK_TAU_S), wing * 1.1)
      v.wing = wing
      const flying = f.state !== "landed"
      // louder the faster it flies (11.09 Pavlo: "sounds from speed too") on top of the wing-MN drive
      const sp = FlyConfig.SOUND_SPEED_MIN + (1 - FlyConfig.SOUND_SPEED_MIN) * Math.min(1, Math.abs(f.speed) / FlyConfig.CRUISE_CM_S)
      const wingGain = FlyConfig.SOUND_WING_MIN_GAIN + (1 - FlyConfig.SOUND_WING_MIN_GAIN) * Math.min(1, wing / v.wingMax)
      let buzz = muted || !flying ? 0 : FlyConfig.SOUND_BUZZ_VOL * wingGain * sp
      if (f.state === "escape" && !muted) buzz = FlyConfig.SOUND_BUZZ_VOL * FlyConfig.SOUND_ESCAPE_GAIN
      // pIP10 idles at ~13 Hz at rest: sing only ABOVE this fly's own slowly-tracked floor
      v.songBase = v.songBase < 0 ? song : song < v.songBase ? song : v.songBase + (song - v.songBase) * (step / 30)
      const excess = Math.max(0, song - v.songBase - FlyConfig.SOUND_SONG_MARGIN_HZ)
      const sing = muted ? 0 : FlyConfig.SOUND_SONG_VOL * Math.min(1, excess / FlyConfig.SOUND_SONG_FULL_HZ)
      v.dist = f.pos.distance(listener)
      v.gain = this.distanceGain(v.dist)
      v.buzzVol += (Math.min(1, buzz * v.gain) - v.buzzVol) * k
      v.songVol += (Math.min(1, sing * v.gain) - v.songVol) * k
      if (v.buzz) v.buzz.volume = v.buzzVol
      if (v.song) v.song.volume = v.songVol
    }
    // the truth in the log, at a rate the device log can carry (hangs off DEBUG_TELEMETRY_S like
    // every other periodic row, RUNBOOK "DEBUG_TELEMETRY_S: 0 but the device log still fills up")
    if (FlyConfig.SOUND_LOG_S > 0 && FlyConfig.DEBUG_TELEMETRY_S > 0 && this.started) {
      this.logAcc += step
      if (this.logAcc >= FlyConfig.SOUND_LOG_S) {
        this.logAcc = 0
        let row = "SOUND"
        for (let i = 0; i < this.voices.length && i < flies.length; i++) {
          const v = this.voices[i]
          const f = flies[i]
          row +=
            (i ? " | " : " ") + "f" + i + " " + f.state + " wing=" + v.wing.toFixed(1) + "/" + v.wingMax.toFixed(0) +
            " sp=" + Math.abs(f.speed).toFixed(0) + " d=" + v.dist.toFixed(0) + " g=" + v.gain.toFixed(2) +
            " buzz=" + v.buzzVol.toFixed(2) + " song=" + v.songVol.toFixed(2)
        }
        log.i(row)
      }
    }
  }
}
