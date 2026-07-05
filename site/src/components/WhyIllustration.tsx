import { DotOrbit, GodRays, Metaballs, Warp } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

/**
 * Small animated shader emblem for one "why" card, echoing the liquid-metal
 * hero mark. Each kind carries its own symbol and hue family:
 * pool (metaballs, mint): subscriptions merging into one pool of capacity;
 * focus (god rays, amber): concentrating an expensive model where it counts;
 * review (warp checks, violet): two model families interleaving over one diff;
 * local (dot orbit, steel): a small self-contained system running on your machine.
 */
export type WhyIllustrationKind = "pool" | "focus" | "review" | "local";

export default function WhyIllustration({ kind }: { kind: WhyIllustrationKind }) {
  const [webglOk, setWebglOk] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    setWebglOk(document.createElement("canvas").getContext("webgl2") !== null);
    setReducedMotion(matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  if (!webglOk) return null;

  const speed = (base: number) => (reducedMotion ? base * 0.15 : base);
  const common = { className: "size-full", colorBack: "#00000000" } as const;

  switch (kind) {
    case "pool":
      return (
        <Metaballs
          {...common}
          colors={["#63f6c9", "#2ea183", "#9ef7dd", "#37d3a6"]}
          count={10}
          size={0.86}
          scale={1}
          speed={speed(0.7)}
        />
      );
    case "focus":
      return (
        <GodRays
          {...common}
          colors={["#e8a063", "#c77854", "#f4c890"]}
          colorBloom="#e8a063"
          density={0.35}
          spotty={0.3}
          midIntensity={0.4}
          midSize={0.2}
          intensity={0.7}
          bloom={0.4}
          speed={speed(0.8)}
        />
      );
    case "review":
      return (
        <Warp
          className="size-full"
          colors={["#14161f", "#8b9bf5", "#14161f", "#4a55c4"]}
          shape="checks"
          shapeScale={0.16}
          proportion={0.45}
          distortion={0.25}
          swirl={0.8}
          swirlIterations={10}
          softness={1}
          scale={0.4}
          speed={speed(0.4)}
        />
      );
    case "local":
      return (
        <DotOrbit
          {...common}
          colors={["#8fa8c0", "#5f7d9c", "#c7d6e4"]}
          size={0.7}
          sizeRange={0.3}
          spreading={0.6}
          stepsPerColor={2}
          scale={0.55}
          speed={speed(0.4)}
        />
      );
  }
}
