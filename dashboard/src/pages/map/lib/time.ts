import type { MapClock } from '../../../../../contracts/ts/ipc.gen';

export function timePhase(time: string, phases: MapClock['phases']) {
  const [hours, minutes] = time.split(':').map(Number);
  const minute = hours * 60 + minutes;
  return phases.find((phase) => minute >= phase.start && minute < phase.end);
}

// Same UTC conversion as tarkov.dev Time.jsx; offsets and fixed map times are data.
export function mapTimes(clock: MapClock, now: number): string[] {
  if (clock.fixed.length) return clock.fixed;
  return clock.offsets.map((hours) =>
    new Date((((now * clock.rate + hours * 3600000) % 86400000) + 86400000) % 86400000)
      .toISOString()
      .slice(11, 19),
  );
}
