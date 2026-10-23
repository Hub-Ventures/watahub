/** Current time in epoch milliseconds. Injected so tests and replays are deterministic. */
export type Clock = () => number

export const systemClock: Clock = () => Date.now()
