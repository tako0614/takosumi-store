import { Show, type Component } from "solid-js";

/**
 * App-store icon. Uses the listing's real `iconUrl` when present; otherwise
 * renders a deterministic glossy colored tile with the app's initial — so the
 * grid always reads like an app store even before publishers add real icons.
 */

function hueFromSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function initial(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0]!.toUpperCase();
}

export const IconTile: Component<{
  label: string;
  seed: string;
  iconUrl?: string;
  size?: number;
}> = (props) => {
  const size = () => props.size ?? 56;
  const hue = () => hueFromSeed(props.seed);
  const gradient = () =>
    `linear-gradient(145deg, hsl(${hue()} 70% 56%), hsl(${(hue() + 26) % 360} 72% 42%))`;
  return (
    <Show
      when={props.iconUrl}
      fallback={
        <span
          class="icon-tile icon-tile-generated"
          style={{
            width: `${size()}px`,
            height: `${size()}px`,
            background: gradient(),
            "font-size": `${Math.round(size() * 0.46)}px`,
          }}
          aria-hidden="true"
        >
          {initial(props.label)}
        </span>
      }
    >
      {(url) => (
        <img
          class="icon-tile"
          src={url()}
          alt=""
          loading="lazy"
          decoding="async"
          width={size()}
          height={size()}
          style={{ width: `${size()}px`, height: `${size()}px` }}
        />
      )}
    </Show>
  );
};
