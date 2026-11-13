import type { components } from './schema';

/** Names for the generated wire types. Nothing here describes the wire by hand. */
type Schemas = components['schemas'];

export type RoutesIn = Schemas['RoutesIn'];
export type RoutesOut = Schemas['RoutesOut'];
export type RouteOut = Schemas['RouteOut'];
export type CheckpointOut = Schemas['CheckpointOut'];
export type WeatherIn = Schemas['WeatherIn'];
export type WeatherOut = Schemas['WeatherOut'];
export type WeatherRouteOut = Schemas['WeatherRouteOut'];
export type WeatherCheckpointOut = Schemas['WeatherCheckpointOut'];
export type ConditionsOut = Schemas['ConditionsOut'];
export type RouteSummaryOut = Schemas['RouteSummaryOut'];
export type RankingOut = Schemas['RankingOut'];
export type RankingStep = Schemas['RankingStep'];
export type GridOut = Schemas['GridOut'];
export type Level = Schemas['Level'];
export type Condition = Schemas['Condition'];
export type AttributionOut = Schemas['AttributionOut'];
export type SuggestionOut = Schemas['SuggestionOut'];
export type AddressSearchOut = Schemas['AddressSearchOut'];
export type ErrorOut = Schemas['ErrorOut'];
export type Spacing = Schemas['PlanParams']['checkpoint_interval_miles'];
