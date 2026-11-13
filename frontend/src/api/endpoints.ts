import { request } from './client';
import type { AddressSearchOut, RoutesIn, RoutesOut, WeatherIn, WeatherOut } from './types';

function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export const fetchRoutes = (body: RoutesIn, signal?: AbortSignal) =>
  post<RoutesOut>('/api/routes', body, signal);

export const fetchWeather = (body: WeatherIn, signal?: AbortSignal) =>
  post<WeatherOut>('/api/weather', body, signal);

export const fetchAddresses = (text: string, signal?: AbortSignal) =>
  request<AddressSearchOut>(`/api/address-search?q=${encodeURIComponent(text)}`, { signal });
