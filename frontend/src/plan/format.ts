/** "1,234 mi": miles rounded to `places` decimals, with a thousands separator. */
export function formatMiles(miles: number, places = 0): string {
  return `${miles.toLocaleString('en-US', { maximumFractionDigits: places })} mi`;
}
