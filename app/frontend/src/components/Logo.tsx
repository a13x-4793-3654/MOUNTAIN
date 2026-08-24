// MOUNTAIN ロゴ（雪をいただいた山のモチーフ）。currentColor を継承するため、
// ヘッダー上では白系で表示される。
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      role="img"
    >
      {/* 奥の山 */}
      <path d="M13 28 L21.5 14 L31 28 Z" fill="currentColor" opacity="0.55" />
      {/* 手前の主峰 */}
      <path d="M1 28 L11 8.5 L21 28 Z" fill="currentColor" opacity="0.95" />
      {/* 雪冠 */}
      <path
        d="M8.1 14.1 L11 8.5 L13.9 14.1 L12.2 13.1 L11 13.9 L9.8 13.1 Z"
        fill="#ffffff"
      />
    </svg>
  );
}
