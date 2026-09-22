/*
 * Implement the standard setInterval unction found in typical JS environments
 * Note: this isn't entirely standard since it doesn't allow arguments after the time
 */
export function setInterval(
  script: BaseScriptComponent,
  callback: () => void,
  time: number
): {cancelled: boolean} {
  const cancelToken = {cancelled: false}
  const interval = () => {
    callback()
    if (!cancelToken.cancelled) {
      setTimeout(script, interval, time)
    }
  }

  setTimeout(script, interval, time)
  // return the event as the "intervalID" used in clearing the event below
  return cancelToken
}

// Implement the standard clearInterval function, expecting the return value from setInterval
export function clearInterval(intervalId: {cancelled: boolean}): void {
  if (intervalId !== undefined && intervalId.cancelled !== undefined) {
    intervalId.cancelled = true
  }
}

export function setTimeout(
  script: BaseScriptComponent,
  callback: () => void,
  time: number
): {cancelled: boolean} {
  const cancelToken = {cancelled: false}
  const delayedEvent = script.createEvent("DelayedCallbackEvent")
  delayedEvent.reset(time / 1000)
  delayedEvent.bind(() => {
    if (!cancelToken.cancelled) {
      callback()
    }
  })
  return cancelToken
}

export function clearTimeout(timeoutId: {cancelled: boolean}): void {
  if (timeoutId !== undefined && timeoutId.cancelled !== undefined) {
    timeoutId.cancelled = true
  }
}
