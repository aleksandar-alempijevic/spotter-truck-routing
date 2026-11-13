import { createContext, useContext } from 'react';

export const WEATHER_UNAVAILABLE = 'Weather unavailable';

/**
 * Whether the weather request failed, so a pending risk reads as unavailable and not as still
 * coming. Set once by the panel; everything that draws a risk reads it from here.
 */
const WeatherFailedContext = createContext(false);

export const WeatherFailedProvider = WeatherFailedContext.Provider;
export const useWeatherFailed = (): boolean => useContext(WeatherFailedContext);
