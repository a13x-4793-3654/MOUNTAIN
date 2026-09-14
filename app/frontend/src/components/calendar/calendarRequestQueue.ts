let active = 0;
const waiters: (() => void)[] = [];

// Keep the cap across range changes and screen remounts while old reads finish.
export async function scheduleCalendarFeedRequest(request: () => Promise<void>) {
  if (active >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
  else active += 1;
  try {
    await request();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }
}
