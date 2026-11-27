/** Milliseconds from `now` to the next time the UTC clock reads `hour`:00. */
export function msUntilUtcHour(now: number, hour: number): number {
  const next = new Date(now)
  next.setUTCHours(hour, 0, 0, 0)
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now
}

/** Runs `task` every day at `hour`:00 UTC. Returns a function that stops the schedule. */
export function everyDayAtUtcHour(
  hour: number,
  task: () => void,
  now: () => number = Date.now,
): () => void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("hour must be an integer between 0 and 23")
  }
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    timer = setTimeout(
      () => {
        try {
          task()
        } catch (error) {
          console.error("demo-web: scheduled task failed", error)
        }
        arm()
      },
      msUntilUtcHour(now(), hour),
    )
  }
  arm()
  return () => clearTimeout(timer)
}
