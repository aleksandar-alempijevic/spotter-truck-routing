/**
 * The basemap's style URL is a build-time setting. OpenFreeMap is the keyless default; the hosted
 * build can point `VITE_BASEMAP_STYLE` elsewhere. Empty counts as unset: a Docker build argument
 * that was not given a value arrives as an empty string.
 */
export const BASEMAP_STYLE_URL: string =
  import.meta.env.VITE_BASEMAP_STYLE || 'https://tiles.openfreemap.org/styles/positron';

/** Used when the basemap cannot be loaded: the plan still draws, on a plain background. */
export const PLAIN_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [
    {
      id: 'plain-background',
      type: 'background' as const,
      paint: { 'background-color': '#e9eef2' },
    },
  ],
};
