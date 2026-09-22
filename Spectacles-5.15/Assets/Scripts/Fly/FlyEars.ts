/**
 * FlyEars — hearing from the Spectacles mic (11.09, Pavlo: "my loud clap should stop the fly, right?").
 * Johnston's organ JO-A/B = the brain's `sound` channel (global, not sided). Atlas: DNpe007 stop +24 Hz,
 * steer -12..-22 = a freeze. No audio goes to the Mac: loud onsets become a brief 0..1 JO stimulus and
 * the brain decides the reaction (ADR 29, no body override).
 *
 * Mic access mirrors the official samples (Voice Playback `MicrophoneRecorder.ts`, RSG
 * `Helpers/MicrophoneRecorder.ts`): a `.micaudio` asset -> `.control as MicrophoneAudioProvider` ->
 * `sampleRate` -> `start()` -> `getAudioFrame()` every update -> `stop()`. Built from FlySwarm's
 * OnStartEvent. VoiceML is NOT required here (bystander rejection is for speech, a clap isn't).
 *
 * Clap detector (engineered, disclosed): `level` = the loudest EAR_BLOCK_MS block RMS of the frame
 * (transient-sensitive); `bg` = a slow follow of that level (EAR_BG_TAU_S), so music, talk and room
 * noise raise it. Onset = level >= EAR_MIN_LEVEL and >= EAR_ONSET_DB above bg, then EAR_REFRACTORY_S.
 * Pulse = EAR_PULSE_MIN..1 by how far above the threshold, decaying linearly to 0 over EAR_PULSE_S.
 * Each fly takes the peak since its own last sense tick: senses run at 4 Hz per fly, so a 0.3 s
 * pulse could otherwise fall between two ticks.
 *
 * ASR coexistence: FlyCommands.onListening -> pause(): the mic is stopped and the pulse cleared while
 * ASK listens (ASR owns the mic); every (re)start gets EAR_WARMUP_S for bg to settle, no onsets.
 * Logs EAR_READY / EAR_ONSET / EAR_PAUSE / EAR_FAIL; telemetry `ears=<level>/<bg> pulses=<n>`.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyEars")

export class FlyEars {
  private mic: MicrophoneAudioProvider | null = null
  private buf: Float32Array = new Float32Array(0)
  private running = false
  private paused = false
  private warmT = 0
  private refrT = 0
  private bg = FlyConfig.EAR_BG_FLOOR
  private pulse = 0
  private peak: number[] = [] // per fly: strongest pulse since its last take()
  private pulses = 0
  private levelMax = 0 // telemetry: loudest level since the last status()
  private err = ""

  constructor(track: AudioTrackAsset, flies: number) {
    for (let i = 0; i < flies; i++) this.peak.push(0)
    try {
      const ctl = track.control as MicrophoneAudioProvider
      if (!ctl || typeof ctl.getAudioFrame !== "function") throw new Error("asset is not a microphone track")
      this.mic = ctl
      this.mic.sampleRate = FlyConfig.EAR_SAMPLE_RATE
      this.setRunning(true)
      log.i("EAR_READY rate=" + this.mic.sampleRate + " maxFrame=" + this.mic.maxFrameSize)
    } catch (e) {
      this.mic = null
      this.err = "" + e
      log.w("EAR_FAIL " + e)
    }
  }

  /** FlyCommands: ASK is listening (ASR owns the mic) -> stop reading and drop any pulse. */
  pause(on: boolean) {
    if (on === this.paused) return
    this.paused = on
    this.setRunning(!on)
    if (on) {
      this.pulse = 0
      for (let i = 0; i < this.peak.length; i++) this.peak[i] = 0
    }
    log.i("EAR_PAUSE " + (on ? "on (ASK listening)" : "off"))
  }

  tick(dt: number) {
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt / FlyConfig.EAR_PULSE_S)
    if (this.refrT > 0) this.refrT -= dt
    if (this.mic && this.running) this.listen(dt)
    for (let i = 0; i < this.peak.length; i++) if (this.pulse > this.peak[i]) this.peak[i] = this.pulse
  }

  /** Sense tick for fly `i`: the strongest pulse since its last tick (0..1), then reset. */
  take(i: number): number {
    const v = Math.max(this.peak[i] || 0, this.pulse)
    this.peak[i] = 0
    return v >= 0.02 ? v : 0
  }

  /** Telemetry for the `dbg` scan string. */
  status(): string {
    if (!this.mic) return "ears=nomic" + (this.err ? "(" + this.err.substring(0, 40) + ")" : "")
    const s = "ears=" + this.levelMax.toFixed(3) + "/" + this.bg.toFixed(3) + " pulses=" + this.pulses + (this.paused ? " paused" : "")
    this.levelMax = 0
    return s
  }

  private setRunning(on: boolean) {
    if (!this.mic || on === this.running) return
    try {
      if (on) this.mic.start()
      else this.mic.stop()
      this.running = on
      if (on) this.warmT = FlyConfig.EAR_WARMUP_S
    } catch (e) {
      log.w("EAR_FAIL " + (on ? "start" : "stop") + ": " + e)
    }
  }

  private listen(dt: number) {
    const mic = this.mic!
    const max = mic.maxFrameSize
    if (max <= 0) return
    if (this.buf.length !== max) this.buf = new Float32Array(max) // the frame array can't exceed maxFrameSize
    const n = Math.min(max, mic.getAudioFrame(this.buf).x)
    if (n <= 0) return // no new audio this frame

    // level = the loudest short block's RMS: a clap is a 5-20 ms transient, a frame RMS would smear it
    const block = Math.max(8, Math.round((mic.sampleRate * FlyConfig.EAR_BLOCK_MS) / 1000))
    let best = 0
    let sum = 0
    let cnt = 0
    for (let k = 0; k < n; k++) {
      const s = this.buf[k]
      sum += s * s
      if (++cnt === block) {
        if (sum > best) best = sum
        sum = 0
        cnt = 0
      }
    }
    let ms = best / block
    if (cnt > 0 && (best === 0 || cnt * 2 >= block)) ms = Math.max(ms, sum / cnt) // short tail block
    const level = Math.sqrt(ms)
    if (level > this.levelMax) this.levelMax = level

    // onset against the background BEFORE the clap can raise it
    const bg = Math.max(this.bg, FlyConfig.EAR_BG_FLOOR)
    const db = (20 * Math.log(Math.max(level / bg, 1e-6))) / Math.LN10
    if (this.warmT > 0) this.warmT -= dt
    else if (this.refrT <= 0 && level >= FlyConfig.EAR_MIN_LEVEL && db >= FlyConfig.EAR_ONSET_DB) {
      const k = Math.min(1, (db - FlyConfig.EAR_ONSET_DB) / FlyConfig.EAR_RANGE_DB)
      const p = FlyConfig.EAR_PULSE_MIN + (1 - FlyConfig.EAR_PULSE_MIN) * k
      if (p > this.pulse) this.pulse = p
      this.refrT = FlyConfig.EAR_REFRACTORY_S
      this.pulses++
      if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
        log.i("EAR_ONSET level=" + level.toFixed(3) + " bg=" + bg.toFixed(4) + " +" + db.toFixed(1) + "dB -> sound " + p.toFixed(2))
      }
    }

    // slow background: sustained music / talk lifts it (fewer onsets), one clap barely moves it;
    // during the warm-up it settles fast
    const tau = this.warmT > 0 ? FlyConfig.EAR_WARMUP_S / 4 : FlyConfig.EAR_BG_TAU_S
    this.bg += (level - this.bg) * (1 - Math.exp(-dt / tau))
  }
}
