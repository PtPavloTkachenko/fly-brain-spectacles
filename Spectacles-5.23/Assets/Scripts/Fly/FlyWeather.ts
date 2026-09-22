/**
 * FlyWeather — the room's climate, read from the real weather forecast (ADR 95).
 *
 * The brain has thermo- and hygroreceptor cells (TRN_VP2 hot, TRN_VP3 cold, HRN_VP4 dry, HRN_VP5
 * moist; `brain_server/channels.py`) that nothing in the room ever drove. Pavlo, 21.09: "take
 * humidity and temperature from the weather forecast; if it is a room, it is simply warmer than
 * outside". So: one Open-Meteo fetch (no key) for the glasses' own position, an indoor offset
 * (+INDOOR_WARM_C, -INDOOR_DRIER_PCT), and the result mapped onto those four cells around the
 * fly's comfort (~25 C, ~50 % RH) as the ROOM BASELINE for every fly. Gemini's per-thing fields
 * (ADR 96) sit on top of it in WorldSources.
 *
 * Refreshed every WEATHER_REFRESH_S. No internet, no permission, a failed fetch: the baseline
 * stays at 0 (neutral, NOT "cold"), one warning, never a stall -- the lens does not wait for it.
 * A failed refresh keeps the last good reading. Status in `dbg` as `clim=...`.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyWeather")

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

/** The baseline every fly gets, 0..1 each; 0 = that cell is not driven. */
export interface Climate {
  hot: number
  cold: number
  dry: number
  moist: number
  wind: number
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export class FlyWeather {
  /** the room baseline; written in place so FlySwarm can hold one reference */
  readonly ch: Climate = { hot: 0, cold: 0, dry: 0, moist: 0, wind: 0 }
  // the reading behind it (NaN until one arrives) -- telemetry, and the board if it ever wants it
  outC = NaN
  outRh = NaN
  windKmh = NaN
  inC = NaN
  inRh = NaN

  private lat = FlyConfig.WEATHER_LAT
  private lon = FlyConfig.WEATHER_LON
  private locSrc = "cfg" // cfg = FlyConfig's default city, gps = the glasses' own position
  private locWaited = 0
  private locDone = !FlyConfig.WEATHER_LOCATION
  private t = 0
  private nextAt = 0
  private busy = false
  private fetches = 0
  private fails = 0
  private lastErr = ""
  private warned = false // one warning per failure family, not one per retry
  private readAt = -1 // lens time of the last good reading
  private internet: InternetModule | null = null

  constructor() {
    if (FlyConfig.WEATHER_LOCATION) this.askLocation()
  }

  /** Where are we? Asked once; the answer moves the next fetch to the real city. Any failure
   *  (no permission, the editor, no fix) leaves the FlyConfig default in place. */
  private askLocation() {
    try {
      require("LensStudio:RawLocationModule")
      const svc = GeoLocation.createLocationService()
      svc.accuracy = GeoLocationAccuracy.Navigation // a city is enough (the d.ts enum here: Navigation/High/Medium/Low)
      svc.getCurrentPosition(
        (pos: GeoPosition) => {
          const moved = Math.abs(pos.latitude - this.lat) > 0.2 || Math.abs(pos.longitude - this.lon) > 0.2
          this.lat = pos.latitude
          this.lon = pos.longitude
          this.locSrc = "gps"
          this.locDone = true
          log.i("WEATHER_LOCATION lat=" + this.lat.toFixed(2) + " lon=" + this.lon.toFixed(2))
          if (moved && this.readAt >= 0) this.nextAt = this.t // a reading for the wrong city: refetch
        },
        (err: string) => {
          this.locDone = true
          log.w("WEATHER_LOCATION none (" + err + "): using FlyConfig.WEATHER_LAT/LON")
        },
      )
    } catch (e) {
      this.locDone = true
      log.w("WEATHER_LOCATION unavailable (" + e + "): using FlyConfig.WEATHER_LAT/LON")
    }
  }

  tick(dt: number) {
    this.t += dt
    // Gemini estimates the climate during the room scan (setFromScan); no GPS, no fetch.
    if (FlyConfig.WEATHER_FROM_SCAN) return
    if (this.busy) return
    // give the position a few seconds to arrive, then go with the default rather than wait
    if (!this.locDone) {
      this.locWaited += dt
      if (this.locWaited < FlyConfig.WEATHER_LOCATION_WAIT_S) return
      this.locDone = true
    }
    if (this.t >= this.nextAt) this.fetch()
  }

  private net(): InternetModule | null {
    if (!this.internet) {
      try {
        this.internet = require("LensStudio:InternetModule") as InternetModule
      } catch (e) {
        return null
      }
    }
    return this.internet
  }

  private fetch() {
    // a refresh with a reading in hand may wait the full interval; with none, retry sooner
    this.nextAt = this.t + (this.readAt >= 0 ? FlyConfig.WEATHER_REFRESH_S : FlyConfig.WEATHER_RETRY_S)
    const net = this.net()
    let online = true
    try {
      online = global.deviceInfoSystem.isInternetAvailable()
    } catch (e) {
      /* no deviceInfoSystem: try anyway */
    }
    if (!net || !online) {
      this.fail(!net ? "no InternetModule" : "no internet")
      return
    }
    this.busy = true
    this.fetches++
    const url =
      OPEN_METEO + "?latitude=" + this.lat.toFixed(3) + "&longitude=" + this.lon.toFixed(3) +
      "&current=temperature_2m,relative_humidity_2m,wind_speed_10m"
    this.get(net, url)
  }

  private async get(net: InternetModule, url: string) {
    try {
      const res = await net.fetch(url, { method: "GET" })
      if (!res.ok) throw new Error("http " + res.status)
      const j = JSON.parse(await res.text())
      const c = j && j.current ? j.current : null
      const tC = c ? Number(c.temperature_2m) : NaN
      const rh = c ? Number(c.relative_humidity_2m) : NaN
      const wind = c ? Number(c.wind_speed_10m) : NaN
      if (!isFinite(tC) || !isFinite(rh)) throw new Error("no current block")
      this.apply(tC, rh, isFinite(wind) ? wind : 0)
    } catch (e) {
      this.fail("" + e)
    }
    this.busy = false
  }

  /** Outside -> the room -> the four cells. Inside the comfort band nothing is driven; outside it
   *  the drive grows linearly to 1.0 over FLY_*_SPAN. Wind is the forecast wind times the indoor
   *  factor (0 = a closed room: it shows in telemetry and drives nothing). */
  private apply(tC: number, rh: number, windKmh: number) {
    this.outC = tC
    this.outRh = rh
    this.windKmh = windKmh
    this.inC = tC + FlyConfig.INDOOR_WARM_C
    this.inRh = Math.max(0, Math.min(100, rh - FlyConfig.INDOOR_DRIER_PCT))
    const ch = this.ch
    ch.hot = clamp01((this.inC - (FlyConfig.FLY_COMFORT_C + FlyConfig.FLY_COMFORT_BAND_C)) / FlyConfig.FLY_HOT_SPAN_C)
    ch.cold = clamp01((FlyConfig.FLY_COMFORT_C - FlyConfig.FLY_COMFORT_BAND_C - this.inC) / FlyConfig.FLY_COLD_SPAN_C)
    ch.moist = clamp01((this.inRh - (FlyConfig.FLY_RH_MID + FlyConfig.FLY_RH_BAND)) / FlyConfig.FLY_RH_SPAN)
    ch.dry = clamp01((FlyConfig.FLY_RH_MID - FlyConfig.FLY_RH_BAND - this.inRh) / FlyConfig.FLY_RH_SPAN)
    ch.wind = clamp01(windKmh / FlyConfig.WEATHER_WIND_FULL_KMH) * FlyConfig.WEATHER_WIND_INDOOR
    this.readAt = this.t
    this.lastErr = ""
    this.warned = false
    log.i("WEATHER_OK out " + tC.toFixed(1) + "C " + rh.toFixed(0) + "% wind " + windKmh.toFixed(0) + "km/h -> room " +
      this.inC.toFixed(1) + "C " + this.inRh.toFixed(0) + "% -> hot=" + ch.hot.toFixed(2) + " cold=" + ch.cold.toFixed(2) +
      " dry=" + ch.dry.toFixed(2) + " moist=" + ch.moist.toFixed(2) + " wind=" + ch.wind.toFixed(2) + " src=" + this.locSrc)
  }

  private fail(why: string) {
    this.fails++
    this.lastErr = why
    this.busy = false
    if (!this.warned) {
      this.warned = true
      log.w("WEATHER_FAIL " + why + (this.readAt >= 0 ? " (keeping the last reading)" : " (baseline stays neutral 0)"))
    }
  }

  /** One compact term for the `dbg` row: the reading, the room, the four cells, where from. */
  /** The room scan estimates the outdoor weather; WorldScanner feeds it here instead of a fetch.
   *  Same apply() pipeline, so nothing downstream changes. */
  setFromScan(tC: number, rh: number, windKmh: number) {
    if (!isFinite(tC) || !isFinite(rh)) return
    this.locSrc = "gemini"
    this.apply(tC, rh, isFinite(windKmh) ? windKmh : 0)
  }

  status(): string {
    const ch = this.ch
    if (this.readAt < 0) return "clim=none" + (this.lastErr ? "(" + this.lastErr.substring(0, 40) + ")" : "") + " src=" + this.locSrc + " tries=" + this.fetches
    return "clim=T" + this.outC.toFixed(1) + "/H" + this.outRh.toFixed(0) + "/W" + this.windKmh.toFixed(0) +
      " room=T" + this.inC.toFixed(1) + "/H" + this.inRh.toFixed(0) +
      " hot=" + ch.hot.toFixed(2) + " cold=" + ch.cold.toFixed(2) + " dry=" + ch.dry.toFixed(2) + " moist=" + ch.moist.toFixed(2) + " wind=" + ch.wind.toFixed(2) +
      " src=" + this.locSrc + " age=" + (this.t - this.readAt).toFixed(0) + "s" + (this.fails ? " fails=" + this.fails : "")
  }
}
