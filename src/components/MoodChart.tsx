"use client";

export default function MoodChart({ series }: { series: { day: string; label: string; mood: number | null }[] }) {
  const L = 34, R = 546, T = 12, B = 160;
  const n = series.length;
  const x = (i: number) => L + (i * (R - L)) / Math.max(n - 1, 1);
  const y = (v: number) => B - ((v - 1) * (B - T)) / 4;
  const pts = series.map((s, i) => (s.mood == null ? null : ([x(i), y(s.mood)] as const))).filter((p): p is readonly [number, number] => !!p);
  const line = pts.map(([a, b]) => `${a},${b}`).join(" ");
  return (
    <svg className="moodchart" viewBox="0 0 560 190" role="img" aria-label="Mood over the last 14 days">
      {[1, 2, 3, 4, 5].map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={R} y1={y(v)} y2={y(v)} />
          <text x={L - 10} y={y(v) + 3} textAnchor="end">{v}</text>
        </g>
      ))}
      {pts.length > 1 && <polygon className="area" points={`${pts[0][0]},${B} ${line} ${pts[pts.length - 1][0]},${B}`} />}
      {pts.length > 1 && <polyline className="ln" points={line} />}
      {series.map((s, i) =>
        s.mood == null ? null : <circle key={s.day} cx={x(i)} cy={y(s.mood)} r={i === n - 1 ? 5.5 : 4} className={s.mood <= 2.5 ? "low" : ""} />,
      )}
      {series.map((s, i) =>
        i % 2 === 1 || i === n - 1 ? (
          <text key={`l${s.day}`} x={x(i)} y={B + 18} textAnchor="middle">{s.label}</text>
        ) : null,
      )}
    </svg>
  );
}
