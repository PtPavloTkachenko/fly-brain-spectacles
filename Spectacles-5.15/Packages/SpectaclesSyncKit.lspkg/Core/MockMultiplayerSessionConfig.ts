export class MockUserConfig {
  connectionId?: string = ""
  displayName?: string = ""
  userId?: string = ""
}

export type LatencySetting = number | [number, number] | null
export const LatencySetting = {
  None: 0,
  OneFrame: 0.0000001 as LatencySetting,

  RandomLowLatency: [0.1, 0.25] as LatencySetting,
  ConsistentLowLatency: 0.05 as LatencySetting,

  RandomHighLatency: [0.75, 1.0] as LatencySetting,
  ConsistentHighLatency: 0.5 as LatencySetting,

  getLatencyValue(setting: LatencySetting): number {
    if (typeof setting === "number") {
      return setting
    }
    if (Array.isArray(setting)) {
      return MathUtils.lerp(setting[0], setting[1], Math.random())
    }
    return LatencySetting.None
  },
}

export class MockMultiplayerSessionConfig {
  connectionLatency?: LatencySetting = LatencySetting.OneFrame
  realtimeStoreLatency?: LatencySetting = LatencySetting.OneFrame
  messageLatency?: LatencySetting = LatencySetting.OneFrame
  localUserInfoLatency?: LatencySetting = LatencySetting.OneFrame

  mockUserInfo?: MockUserConfig

  static createWithAllSetting(
    setting: LatencySetting,
  ): MockMultiplayerSessionConfig {
    const ret = new MockMultiplayerSessionConfig()
    ret.connectionLatency = setting
    ret.localUserInfoLatency = setting
    ret.messageLatency = setting
    ret.realtimeStoreLatency = setting
    return ret
  }

  static createWithNoLatency(): MockMultiplayerSessionConfig {
    return this.createWithAllSetting(LatencySetting.None)
  }

  static createWithOneFrameLatency(): MockMultiplayerSessionConfig {
    return this.createWithAllSetting(LatencySetting.OneFrame)
  }

  static createWithSimulatedLowLatency(): MockMultiplayerSessionConfig {
    return this.createWithAllSetting(LatencySetting.RandomLowLatency)
  }

  static createWithSimulatedHighLatency(): MockMultiplayerSessionConfig {
    return this.createWithAllSetting(LatencySetting.RandomHighLatency)
  }
}
