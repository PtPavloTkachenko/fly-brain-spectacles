/**
 * FlyVerdict — what a teaching session actually showed, read back by Gemini (ADR 68).
 *
 * A session ends in a dozen numbers. Gemini turns them into three sentences a person can act on —
 * and nothing else. The one rule that matters: **it may not invent a number.** Every figure it
 * quotes has to come out of the evidence pack it is handed, the control has to be named beside the
 * cue, and the honest null-result rule from `docs/TEACHING.md` is written into the system prompt, so
 * "the synapses moved" never becomes "the fly learned" on its own.
 *
 * It is a reader, never a judge of the experiment: `learned` is its reading of the pack, and the
 * pack itself (with the frozen-control flag) travels next to it to the page and the log.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/Gemini"
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GeminiTypes"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyVerdict")

/** exactly what the page and the guide get back */
export type TrainVerdict = {
  learned: string // "yes" | "no" | "unclear"
  confidence: number // 0..1
  what: string // one line: what the fly now does differently
  evidence: string[]
  caveats: string[]
  next: string[]
  plain: string // three sentences for the user
  via: string // "gemini" | "local (...)": never hidden
}

const PROMPT =
  "You read the result of a real conditioning experiment on a reconstructed fruit-fly brain and " +
  "report what it shows. You are a careful lab partner, not a marketer.\n" +
  "HARD RULES.\n" +
  "1. Never invent a number. Every figure you quote must appear in the pack you are given. If a " +
  "figure is missing, say it is missing rather than estimating it.\n" +
  "2. Always name the CONTROL beside the cue. A change on the cue alone is not a result: the " +
  "control thing was shown just as often and never paid, so only the DIFFERENCE between them means " +
  "anything.\n" +
  "3. If `frozen` is true the brain could not learn at all — that run is a control, so `learned` is " +
  "\"no\" and you say why.\n" +
  "4. The honest null rule: synapses moving is not learning. `effOn` is the efficacy of the " +
  "synapses that the cue itself drives, and it is the trustworthy signal; `bias` is the fly's " +
  "turning and it is noisy between sessions. If effOn separates cue from control but the bias does " +
  "not, say exactly that: the memory formed, the behaviour has not followed.\n" +
  "5. A miss is the fly refusing, not a failure of the experiment. Nothing here pushes it around.\n" +
  "`learned` is \"yes\" only when the cue and the control separate in the expected direction. " +
  "`plain` is three short sentences addressed to the person wearing the glasses, no jargon, no " +
  "exclamation marks, and it must not contain a number that is not in the pack. Answer as JSON only."

const SCHEMA: GeminiTypes.Common.Schema = {
  type: "object",
  properties: {
    learned: { type: "string" },
    confidence: { type: "number" },
    what: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    caveats: { type: "array", items: { type: "string" } },
    next: { type: "array", items: { type: "string" } },
    plain: { type: "string" },
  },
  required: ["learned", "confidence", "what", "evidence", "caveats", "next", "plain"],
}

function parseAnswer(t: string): any {
  try {
    const s = t.replace(/```(?:json)?/g, "").trim()
    const a = s.indexOf("{")
    const b = s.lastIndexOf("}")
    if (a < 0 || b <= a) return null
    const o = JSON.parse(s.substring(a, b + 1))
    return o && typeof o === "object" ? o : null
  } catch (e) {
    return null
  }
}

const one = (x: number, n: number) => (isFinite(x) ? x.toFixed(n) : "-")

/** what the pack says when Gemini is unreachable: the numbers, stated flatly, no interpretation */
export function localVerdict(pack: any): TrainVerdict {
  const d = pack.effOn && isFinite(pack.effOn.cue) && isFinite(pack.effOn.control)
    ? pack.effOn.cue - pack.effOn.control : NaN
  const frozen = !!pack.frozen
  const learned = frozen ? "no" : isFinite(d) ? (d < -0.002 ? "yes" : d > 0.002 ? "no" : "unclear") : "unclear"
  const ev: string[] = []
  if (isFinite(d)) ev.push("synapses of the cue " + one(pack.effOn.cue, 5) + " against the control " + one(pack.effOn.control, 5))
  if (pack.bias) ev.push("turning toward the cue " + one(pack.bias.before, 2) + " to " + one(pack.bias.after, 2))
  return {
    learned: learned,
    confidence: frozen ? 1 : isFinite(d) ? Math.min(1, Math.abs(d) * 40) : 0,
    what: frozen ? "nothing: the brain's synapses were frozen for this run" : isFinite(d)
      ? "the synapses carrying the cue and the ones carrying the control ended " + one(d, 5) + " apart"
      : "not enough was measured to say",
    evidence: ev,
    caveats: ["written without Gemini: these are the numbers, not a reading of them"],
    next: ["run TEST to measure it again without teaching"],
    plain: frozen
      ? "This run could not change anything — the brain's synapses were frozen, which makes it a control. Nothing was learned and nothing was lost. Run it again with a teaching session to see a real change."
      : isFinite(d)
        ? "The synapses that carry your cue ended " + one(d, 5) + " away from the ones that carry the control thing. Whether the fly's flying has changed is a separate question, and the turning numbers are noisy. Run TEST to check it again without teaching it anything further."
        : "This session did not gather enough to judge. The fly may have refused the cue, or the run ended early. Try again with the cue somewhere it can reach.",
    via: "local",
  }
}

/**
 * Ask Gemini to read the pack. `cb` always fires exactly once — with Gemini's reading, or with the
 * local one and the reason in `via`.
 */
export function askVerdict(pack: any, cb: (v: TrainVerdict) => void) {
  if (!FlyConfig.TRAIN_VERDICT) {
    cb(localVerdict(pack))
    return
  }
  let done = false
  const finish = (v: TrainVerdict) => {
    if (done) return
    done = true
    cb(v)
  }
  const req: GeminiTypes.Models.GenerateContentRequest = {
    model: FlyConfig.GEMINI_MODEL,
    type: "generateContent",
    body: {
      contents: [{ role: "user", parts: [{ text: JSON.stringify(pack) }] }],
      systemInstruction: { parts: [{ text: PROMPT }] },
      generationConfig: {
        temperature: 0,
        maxOutputTokens: FlyConfig.TRAIN_VERDICT_TOKENS,
        responseMimeType: "application/json",
        response_schema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    },
  }
  try {
    Gemini.models(req)
      .then((r: any) => {
        const cand: any = r && r.candidates ? r.candidates[0] : null
        const parts: any[] = cand && cand.content && cand.content.parts ? cand.content.parts : []
        const a = parseAnswer(parts.map((p: any) => p.text || "").join(""))
        if (!a || !a.plain) {
          const v = localVerdict(pack)
          v.via = "local (no answer, finish=" + (cand ? cand.finishReason : "none") + ")"
          finish(v)
          return
        }
        const arr = (x: any) => (Array.isArray(x) ? x.map((s: any) => "" + s).slice(0, 6) : [])
        finish({
          learned: "" + (a.learned || "unclear"),
          confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
          what: "" + (a.what || ""),
          evidence: arr(a.evidence),
          caveats: arr(a.caveats),
          next: arr(a.next),
          plain: "" + a.plain,
          via: "gemini",
        })
      })
      .catch((e: any) => {
        const v = localVerdict(pack)
        v.via = "local (" + e + ")"
        finish(v)
      })
  } catch (e) {
    const v = localVerdict(pack)
    v.via = "local (" + e + ")"
    finish(v)
  }
  log.d("TRAIN_VERDICT asked")
}
