import confetti from 'canvas-confetti';

let last = 0;

/** Confetti burst — throttled so celebrations stay special. */
export function celebrate(origin?: { x: number; y: number }) {
  const now = Date.now();
  if (now - last < 1200) return;
  last = now;
  const colors = ['#3987e5', '#9085e9', '#1baf7a', '#eda100', '#e87ba4'];
  confetti({
    particleCount: 90,
    spread: 75,
    startVelocity: 38,
    scalar: 0.9,
    ticks: 180,
    colors,
    origin: origin ?? { x: 0.5, y: 0.35 },
    disableForReducedMotion: true,
  });
  setTimeout(
    () =>
      confetti({
        particleCount: 40,
        spread: 110,
        startVelocity: 26,
        scalar: 0.7,
        ticks: 150,
        colors,
        origin: origin ? { x: origin.x, y: Math.max(0, origin.y - 0.05) } : { x: 0.5, y: 0.3 },
        disableForReducedMotion: true,
      }),
    180,
  );
}
