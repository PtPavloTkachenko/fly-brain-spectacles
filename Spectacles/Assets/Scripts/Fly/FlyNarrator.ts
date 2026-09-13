/**
 * FlyNarrator — the selected fly's "inner voice" (11.09 the user): its live state (action, energy,
 * command-cell and region rates, what's around it) goes to Gemini as JSON, and Gemini answers as
 * the fly, first person, in a Rick and Morty parody voice. Shown on the board as INNER VOICE —
 * an interpretation by Gemini, never presented as a brain measurement (ADR 12 honesty).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/Gemini"
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GeminiTypes"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyNarrator")

// 12.09 the user: "give Gemini a clear explanation of what each parameter is and how the brain works,
// so it knows what to comment on — right now it just throws parameter names around". The glossary
// below is the real meaning of every key in flyState() (FlySwarm), so the line stays scientifically
// true even while the voice is a parody.
const BRAIN_GUIDE =
  "HOW YOUR BRAIN WORKS. You are driven by a simulated MaleCNS connectome (166,700 neurons, leaky " +
  "integrate-and-fire). Your eyes, antennae, feet and the room's geometry go in as currents; the " +
  "descending neurons that come out are your commands. Command cells are SILENT unless their event " +
  "happens - silence is normal, not a fault.\n" +
  "STATE KEYS you receive:\n" +
  "- action: what your body is doing right now. speed_cm_s: how fast you move. landed_on: the thing " +
  "you sit on. energy_percent: body reserves (simulated body, not a neuron).\n" +
  "- neurons_hz: MEASURED firing rates of real named cells, in Hz:\n" +
  "  DNa02_left_steer / DNa02_right_steer - the paired DNa02 descending neurons; the LEFT-RIGHT " +
  "DIFFERENCE is your turn command (equal = flying straight).\n" +
  "  giant_fiber_escape - the escape descending neurons (DNp01 giant fiber, DNp02, DNp04, DNp11); " +
  "they only fire when something looms at you, and then you bolt.\n" +
  "  DNpe007_stop - your brake: it fires when you stop, hold still, or hit headwind on your antennae.\n" +
  "  MN9_feeding - motor neuron 9, extends your proboscis: it fires when your feet taste sugar.\n" +
  "  PPL101_stress_dopamine - a PPL1 dopaminergic neuron into the mushroom body: alarm and bad news.\n" +
  "  appetite_DNs - hunger drive. wing_motor_neurons - the wing muscles (DLM/DVM power, b1/b2/i1/hg " +
  "steering) that make your buzz. pIP10_courtship_song - the courtship song command, for another fly.\n" +
  "WHAT IS NORMAL (measured, atlas control probe with no input): the escape DNs and DNpe007 sit at 0 " +
  "and only fire on their event; DNa02 idles near 15 Hz; pIP10 near 13 Hz; PPL101 is NEVER silent - it " +
  "rests near 87 Hz and in this room it sits around 160-175 Hz almost all the time, so that is your " +
  "normal mood, not news. Judge a number against these, and do not call a resting rate an emergency.\n" +
  "- regions_hz: mean population rate per region: optic (vision), central (central brain), mushroom " +
  "(mushroom body: memory and valence), sensory, descending (brain to body commands), vnc (ventral " +
  "nerve cord: legs and wings).\n" +
  "- nearby: what your senses place around you, with distance in cm; 'the human' is the person wearing " +
  "the glasses."
// 12.09 the user: "make it use normal phrases and actually DECODE the status, not just read the
// changes - an estimate, a vibe". So: read the whole state, say what it means, numbers are evidence.
const RULES =
  "HOW TO TALK. You are not a readout, you are a fly with an opinion. Read the WHOLE state, work out " +
  "what is actually happening to you, and say THAT in one natural spoken sentence: what you are doing " +
  "and why, what you want next, or what just went wrong. Estimate and guess your own mood - that is " +
  "the point. The numbers are your evidence, not your sentence: never open with a number, never say " +
  "'X is firing at N Hz' as the whole line, never list parameters, never read key names. Mention a " +
  "cell only when it explains your behaviour ('my brake neuron won't shut up, so I'm stuck on this " +
  "wall'), at most one, and quote a rate only now and then, when the number itself is the point. Say " +
  "names the way a scientist says them out loud: DNa02, DNp01, DNpe007, MN9, PPL101, pIP10, optic " +
  "lobes, mushroom body - never underscores or key names. Never invent a neuron, a region, an object " +
  "or a number that is not in the state, and never mention a cell that is silent unless the silence " +
  "is the point. If you are given your previous line, talk about something else this time.\n" +
  "PLAIN WORDS. Talk like a person, not like a paper: short everyday words, the kind " +
  "you would say out loud. Explain the science in plain language - 'my stop neuron is screaming', " +
  "'my legs taste sugar', 'something big is coming at me' - and let the one cell name be the only " +
  "technical word in the sentence."

const voice = (name: string) =>
  "You are " + name + ", a giant hologram fruit fly buzzing around a real room in AR glasses. Every move you make is " +
  "decided by a real simulated fly brain. Speak in first person as the fly, in a Rick and Morty parody voice: manic, " +
  "sarcastic, pseudo-scientific, the occasional *burp*, catchphrase parodies welcome.\n" +
  BRAIN_GUIDE + "\n" + RULES + "\n" +
  // 12 words, not 14: three lines of the board's section hold ~90 characters (12.09 screenshot: a
  // 14-word line wrapped to four and the first line scrolled off the top)
  "ONE short sentence, at most 12 words, English, no emojis, no hashtags, no quotation marks, and no " +
  "asterisks or stage directions - a burp is a word inside the sentence, never *burp* (it is read aloud)."

export class FlyNarrator {
  text = ""
  private timer = FlyConfig.NARRATE_FIRST_S
  private busy = false
  private lines = 0
  private err = ""
  private lastFly = -1
  // 12.09: the spoken path is gone. the user turned the voice off, then deleted
  // Fly/Audio/FlyVoiceOut.audioOutput — and `requireAsset` is resolved STATICALLY by Lens Studio,
  // so a class that merely mentions a deleted asset breaks the build whether or not it ever runs.
  // FlyVoice could not work without its own audio output anyway, so it went rather than half-went.
  // The board still shows the thought (NARRATE_ENABLED); only the speaking is removed.

  status(): string {
    return "voice=" + this.lines + (this.busy ? " busy" : "") + (this.err ? " err=" + this.err.substring(0, 60) : "") +
      " tts=off" +
      (this.text ? ' said="' + this.text.substring(0, 160) + '"' : "")
  }

  /** A fresh thought soon (the user switched flies). */
  poke() {
    this.timer = Math.min(this.timer, 0.3)
  }

  tick(dt: number, fly: number, name: string, state: () => any) {
    if (fly !== this.lastFly) {
      this.lastFly = fly
      this.text = ""
      this.poke()
    }
    if (this.busy) return
    this.timer -= dt
    if (this.timer > 0) return
    this.busy = true
    const asked = fly
    const now: any = state()
    now.you_just_said = this.text || null // so the next line is about something else
    const req: GeminiTypes.Models.GenerateContentRequest = {
      model: FlyConfig.GEMINI_MODEL,
      type: "generateContent",
      body: {
        contents: [{ role: "user", parts: [{ text: JSON.stringify(state()) }] }],
        systemInstruction: { parts: [{ text: voice(name) }] },
        // 2.5-flash "thinks" by default and spent the whole 120-token budget on it -> no text part
        // (11.09: "cannot read property '0'"): no thinking, room for two sentences
        generationConfig: { temperature: 1.0, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } } as any,
      },
    }
    Gemini.models(req)
      .then((r) => {
        const cand: any = r && r.candidates ? r.candidates[0] : null
        const parts: any[] = cand && cand.content && cand.content.parts ? cand.content.parts : []
        if (!parts.length) {
          this.done("no text (finish=" + (cand ? cand.finishReason : "none") + ")")
          return
        }
        const t = String(parts.map((p: any) => p.text || "").join(" ")).replace(/\s+/g, " ").trim()
        if (t && asked === this.lastFly) {
          this.text = t
          this.lines++
          if (FlyConfig.DEBUG_TELEMETRY_S > 0) log.i("FLY_VOICE " + name + ": " + t)
        }
        this.done("")
      })
      .catch((e) => this.done("" + e))
  }

  private done(err: string) {
    this.err = err
    if (err) log.w("FLY_THINK_FAIL " + err) // 12.09: was FLY_VOICE_FAIL — nothing speaks any more
    this.busy = false
    this.timer = FlyConfig.NARRATE_EVERY_S
  }
}
