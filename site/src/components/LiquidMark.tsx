import { LiquidMetal } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

/**
 * The relay-aperture mark rendered as animated liquid metal via
 * paper-design shaders. Falls back to the static mark image when WebGL is
 * unavailable, and freezes when the user prefers reduced motion.
 */
export default function LiquidMark({ maskSrc, fallbackSrc }: { maskSrc: string; fallbackSrc: string }) {
  const [webglOk, setWebglOk] = useState<boolean | undefined>(undefined);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    setWebglOk(canvas.getContext("webgl2") !== null);
    setReducedMotion(matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  if (webglOk === undefined) return <div className="size-full" aria-hidden="true" />;

  if (!webglOk) {
    return <img src={fallbackSrc} alt="" className="size-full opacity-80" aria-hidden="true" />;
  }

  return (
    <LiquidMetal
      className="size-full"
      image={maskSrc}
      colorBack="#00000000"
      colorTint="#ffffff"
      // slow drift instead of a full stop under reduced motion: the flow is
      // small-area and low-contrast, and a frozen hero reads as broken
      speed={reducedMotion ? 0.15 : 1.1}
      repetition={2.4}
      softness={0.25}
      shiftRed={0.25}
      shiftBlue={0.35}
      distortion={0.12}
      contour={0.9}
      angle={72}
      scale={1}
      fit="contain"
    />
  );
}
