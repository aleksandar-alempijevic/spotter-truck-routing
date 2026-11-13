import { worstRisk, type RiskState } from '../risk/levels';
import type { RouteView } from '../plan/view';

/** The worst level on a route, or pending / no forecast when it has none. */
export function routeWorstRisk(route: RouteView): RiskState {
  return worstRisk(route.checkpoints.map((cp) => cp.risk));
}
